<?php declare(strict_types=1);

namespace Sidworks\DevTools\Subscriber;

use Sidworks\DevTools\Registry\TemplateRegistry;
use Sidworks\DevTools\Service\ConfigService;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;

class ResponseSubscriber implements EventSubscriberInterface
{
    private ConfigService $configService;
    private bool $debugMode;
    private string $projectDir;

    public function __construct(
        ConfigService $configService,
        bool $debugMode,
        string $projectDir
    ) {
        $this->configService = $configService;
        $this->debugMode = $debugMode;
        $this->projectDir = $projectDir;
    }

    public static function getSubscribedEvents(): array
    {
        return [
            KernelEvents::RESPONSE => ['onResponse', -1000],
        ];
    }

    public function onResponse(ResponseEvent $event): void
    {
        if (!$event->isMainRequest()) {
            return;
        }

        if (!$this->configService->isEnabled() || !$this->debugMode) {
            return;
        }

        $response = $event->getResponse();
        $contentType = $response->headers->get('Content-Type', '');

        // Only inject into HTML responses
        if (!str_contains($contentType, 'text/html') && !empty($contentType)) {
            return;
        }

        $content = $response->getContent();

        if (empty($content)) {
            return;
        }

        // Get project path - priority: DDEV env var > config > kernel project dir
        $projectPath = getenv('PROJECT_PATH') ?: $this->configService->getProjectPath() ?: $this->projectDir;
        $templates = TemplateRegistry::all();

        $debugScript = sprintf(
            '<script type="application/json" id="sidworks-shopware-devtools-data">%s</script>',
            json_encode([
                'projectPath' => $projectPath,
                'timestamp' => time(),
                'url' => $event->getRequest()->getRequestUri(),
                'templates' => $templates,
            ], JSON_PRETTY_PRINT)
        );

        // Remove SWDT comments from inside HTML attribute values
        $content = $this->removeCommentsFromAttributes($content);

        // Remove SWDT comments from inside special tags (title, meta, style, script, noscript)
        $content = $this->removeCommentsFromSpecialTags($content);

        $content = str_replace('</body>', $debugScript . '</body>', $content);
        $response->setContent($content);

        // Clear registry for next request
        TemplateRegistry::clear();
    }

    /**
     * Remove SWDT debug comments from inside HTML attribute values
     * This prevents breaking attributes like class="<!-- SWDT_START... -->value<!-- SWDT_END... -->"
     */
    private function removeCommentsFromAttributes(string $content): string
    {
        // Simple approach: find all attribute values (text between ="" quotes)
        // and remove SWDT comments from them
        $result = preg_replace_callback(
            '/(\w+)="((?:[^"\\\\]|\\\\.)*)"/s',
            function ($matches) {
                $attrName = $matches[1];
                $attrValue = $matches[2];

                // Remove all SWDT_START and SWDT_END comments from the attribute value
                $cleanedValue = preg_replace(
                    '/<!--\s*SWDT_(START|END)\[.*?\].*?-->/s',
                    '',
                    $attrValue
                );

                return $attrName . '="' . $cleanedValue . '"';
            },
            $content
        );

        // Return original content if preg_replace_callback failed (returns null on error)
        return $result ?? $content;
    }

    /**
     * Remove SWDT debug comments from inside special HTML tags
     * Handles: title, style, script, noscript tags
     * These tags should not contain HTML comments in their content
     */
    private function removeCommentsFromSpecialTags(string $content): string
    {
        // List of tags where we should remove SWDT comments from the content
        $specialTags = ['title', 'style', 'script', 'noscript'];

        foreach ($specialTags as $tag) {
            // Match opening tag, content, and closing tag
            // Use backreference \1 to match the same tag name in closing tag
            $result = preg_replace_callback(
                '/<(' . $tag . ')([^>]*)>(.*?)<\/\1>/si',
                function ($matches) {
                    $tag = $matches[1];
                    $attributes = $matches[2];
                    $tagContent = $matches[3];

                    // Remove SWDT comments from the tag content
                    // Handle both regular HTML comments and HTML-encoded comments
                    $cleanedContent = preg_replace(
                        [
                            '/<!--\s*SWDT_(START|END)\[.*?\].*?-->/s',
                            '/&lt;!--\s*SWDT_(START|END)\[.*?\].*?--&gt;/s',
                        ],
                        '',
                        $tagContent
                    );

                    return '<' . $tag . $attributes . '>' . $cleanedContent . '</' . $tag . '>';
                },
                $content
            );

            // Keep original content if preg_replace_callback failed (returns null on error)
            $content = $result ?? $content;
        }

        return $content;
    }
}
