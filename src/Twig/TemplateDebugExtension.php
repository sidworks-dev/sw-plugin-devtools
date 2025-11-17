<?php declare(strict_types=1);

namespace Sidworks\DevTools\Twig;

use Sidworks\DevTools\Registry\TemplateRegistry;
use Sidworks\DevTools\Service\ConfigService;
use Twig\Extension\AbstractExtension;
use Twig\TwigFunction;

class TemplateDebugExtension extends AbstractExtension
{
    private bool $debugMode;
    private ConfigService $configService;

    public function __construct(bool $debugMode, ConfigService $configService)
    {
        $this->debugMode = $debugMode;
        $this->configService = $configService;
    }

    public function getFunctions(): array
    {
        return [
            new TwigFunction('swdt_track_block', [$this, 'trackBlock']),
            new TwigFunction('swdt_start_marker', [$this, 'startMarker'], ['is_safe' => ['html']]),
            new TwigFunction('swdt_end_marker', [$this, 'endMarker'], ['is_safe' => ['html']]),
        ];
    }

    public function trackBlock(int $id, string $block, string $template, string $path, int $line, string $extends): void
    {
        TemplateRegistry::add([
            'id' => $id,
            'block' => $block,
            'template' => $template,
            'path' => $path,
            'line' => $line,
            'extends' => $extends,
        ]);
    }

    public function startMarker(int $id): string
    {
        return sprintf('<!-- SWDT:%d -->', $id);
    }

    public function endMarker(int $id): string
    {
        return sprintf('<!-- /SWDT:%d -->', $id);
    }

    public function getNodeVisitors(): array
    {
        // Only create the visitor if both debug mode and plugin are enabled
        if (!$this->debugMode || !$this->configService->isEnabled()) {
            return [];
        }

        return [
            new TemplateDebugNodeVisitor(),
        ];
    }
}
