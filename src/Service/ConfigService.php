<?php declare(strict_types=1);

namespace Sidworks\DevTools\Service;

use Shopware\Core\System\SystemConfig\SystemConfigService;

class ConfigService
{
    private const CONFIG_KEY = 'SidworksDevTools.config.';

    private SystemConfigService $systemConfigService;

    public function __construct(SystemConfigService $systemConfigService)
    {
        $this->systemConfigService = $systemConfigService;
    }

    public function isEnabled(?string $salesChannelId = null): bool
    {
        return (bool) $this->systemConfigService->get(self::CONFIG_KEY . 'enabled', $salesChannelId);
    }

    public function getProjectPath(?string $salesChannelId = null): ?string
    {
        $path = $this->systemConfigService->get(self::CONFIG_KEY . 'projectPath', $salesChannelId);
        return $path ? (string) $path : null;
    }
}
