<?php declare(strict_types=1);

namespace Sidworks\DevTools\Tests\Unit\Subscriber;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Sidworks\DevTools\Service\ConfigService;
use Sidworks\DevTools\Subscriber\ResponseSubscriber;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\HttpKernelInterface;

final class ResponseSubscriberTest extends TestCase
{
    private const START = '<!-- SWDT_START[1]|base_body_classes|template|path|25| -->';
    private const END = '<!-- SWDT_END[1] -->';

    #[DataProvider('attributeQuotes')]
    public function testLongAttributesDoNotPreventCleaningBodyClasses(string $quote): void
    {
        $payload = str_repeat('x', 200000);
        $html = '<html><head><meta data-long=' . $quote . $payload . $quote . '></head>'
            . '<body class=' . $quote . self::START . 'is-ctl-accountorder is-act-editorder' . self::END . $quote . '>'
            . self::START . '<main>Order</main>' . self::END . '</body></html>';

        $content = $this->process($html)->getContent();

        self::assertTrue(str_contains($content, 'class=' . $quote . 'is-ctl-accountorder is-act-editorder' . $quote), 'Body classes must contain no debug markers.');
        self::assertTrue(str_contains($content, 'data-long=' . $quote . $payload . $quote), 'The long attribute must be preserved.');
        self::assertStringContainsString(self::START . '<main>Order</main>' . self::END, $content);
        self::assertStringContainsString('id="sidworks-devtools-data"', $content);
    }

    public static function attributeQuotes(): iterable
    {
        yield 'double quoted' => ['"'];
        yield 'single quoted' => ["'"];
    }

    public function testAttributeNamesWhitespaceAndEscapedValuesArePreserved(): void
    {
        $html = '<html><body><input aria-label = "' . self::START . 'Search &quot;products&quot;' . self::END . '"'
            . " data-options = '" . self::START . '{"path":"C:\\shop","label":"Products"}' . self::END . "'"
            . ' value=""></body></html>';

        $content = $this->process($html)->getContent();

        self::assertStringContainsString('aria-label = "Search &quot;products&quot;"', $content);
        self::assertStringContainsString("data-options = '{\"path\":\"C:\\shop\",\"label\":\"Products\"}'", $content);
        self::assertStringContainsString('value=""', $content);
    }

    #[DataProvider('unmodifiedResponses')]
    public function testResponsesOutsideEnabledMainHtmlRequestsAreUnchanged(bool $enabled, bool $debug, int $requestType, string $contentType): void
    {
        $html = '<html><body class="' . self::START . 'example' . self::END . '"></body></html>';

        self::assertSame($html, $this->process($html, $enabled, $debug, $requestType, $contentType)->getContent());
    }

    public static function unmodifiedResponses(): iterable
    {
        yield 'disabled plugin' => [false, true, HttpKernelInterface::MAIN_REQUEST, 'text/html'];
        yield 'production mode' => [true, false, HttpKernelInterface::MAIN_REQUEST, 'text/html'];
        yield 'subrequest' => [true, true, HttpKernelInterface::SUB_REQUEST, 'text/html'];
        yield 'JSON response' => [true, true, HttpKernelInterface::MAIN_REQUEST, 'application/json'];
    }

    private function process(
        string $html,
        bool $enabled = true,
        bool $debug = true,
        int $requestType = HttpKernelInterface::MAIN_REQUEST,
        string $contentType = 'text/html'
    ): Response {
        $config = $this->createStub(ConfigService::class);
        $config->method('isEnabled')->willReturn($enabled);
        $response = new Response($html, headers: ['Content-Type' => $contentType]);
        $event = new ResponseEvent(
            $this->createStub(HttpKernelInterface::class),
            Request::create('https://shop.example/account/order/edit/test'),
            $requestType,
            $response
        );

        (new ResponseSubscriber($config, $debug, '/var/www/html'))->onResponse($event);

        return $response;
    }
}
