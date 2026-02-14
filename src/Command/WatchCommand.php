<?php declare(strict_types=1);

namespace Sidworks\DevTools\Command;

use Shopware\Core\Defaults;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Storefront\Theme\AbstractThemePathBuilder;
use Shopware\Storefront\Theme\ConfigLoader\AbstractAvailableThemeProvider;
use Shopware\Storefront\Theme\ConfigLoader\StaticFileConfigDumper;
use Shopware\Storefront\Theme\StorefrontPluginRegistry;
use Shopware\Storefront\Theme\ThemeCollection;
use Shopware\Storefront\Theme\ThemeEntity;
use Shopware\Storefront\Theme\ThemeFileResolver;
use Shopware\Storefront\Theme\ThemeFilesystemResolver;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Component\Process\Process;

#[AsCommand(
    name: 'sidworks:watch',
    description: 'Prepare theme data for the SidworksDevTools SCSS watcher',
)]
class WatchCommand extends Command
{
    private readonly Context $context;

    /**
     * @param EntityRepository<ThemeCollection> $themeRepository
     */
    public function __construct(
        private readonly StorefrontPluginRegistry $pluginRegistry,
        private readonly ThemeFileResolver $themeFileResolver,
        private readonly EntityRepository $themeRepository,
        private readonly AbstractAvailableThemeProvider $themeProvider,
        private readonly ThemeFilesystemResolver $themeFilesystemResolver,
        private readonly StaticFileConfigDumper $staticFileConfigDumper,
        private readonly AbstractThemePathBuilder $themePathBuilder,
    ) {
        parent::__construct();
        $this->context = Context::createCLIContext();
    }

    protected function configure(): void
    {
        $this->addOption('prep-only', null, InputOption::VALUE_NONE, 'Only run prep (dump + compile), do not start the file watcher');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $application = $this->getApplication();

        if ($application === null) {
            $io->error('No application available');

            return self::FAILURE;
        }

        // Run prerequisite commands
        $io->section('Running bundle:dump');
        $application->find('bundle:dump')->run(new ArrayInput([]), $output);

        $io->section('Running feature:dump');
        $application->find('feature:dump')->run(new ArrayInput([]), $output);

        $io->section('Running theme:compile --active-only');
        $application->find('theme:compile')->run(
            new ArrayInput(['--active-only' => true]),
            $output,
        );

        // Gather all active themes
        $io->section('Gathering theme data');
        $salesChannelToTheme = $this->themeProvider->load($this->context, true);

        // Group sales channels by theme ID
        /** @var array<string, list<string>> $themeToSalesChannels */
        $themeToSalesChannels = [];
        foreach ($salesChannelToTheme as $salesChannelId => $themeId) {
            $themeToSalesChannels[$themeId][] = $salesChannelId;
        }

        $themes = [];

        foreach ($themeToSalesChannels as $themeId => $salesChannelIds) {
            $technicalName = $this->getTechnicalName($themeId);
            if ($technicalName === null) {
                $io->warning(\sprintf('Could not resolve technical name for theme %s, skipping', $themeId));

                continue;
            }

            $themeConfig = $this->pluginRegistry->getConfigurations()->getByTechnicalName($technicalName);
            if ($themeConfig === null) {
                $io->warning(\sprintf('No config found for theme "%s", skipping', $technicalName));

                continue;
            }

            // Resolve style files
            $this->themeFilesystemResolver->getFilesystemForStorefrontConfig($themeConfig);
            $resolvedFiles = $this->themeFileResolver->resolveFiles(
                $themeConfig,
                $this->pluginRegistry->getConfigurations(),
                true,
            );

            // Get domain URL from the first sales channel
            $domainUrl = $this->getDomainUrl($salesChannelIds[0]);

            // Build output paths for each sales channel using this theme
            $outputPaths = [];
            foreach ($salesChannelIds as $salesChannelId) {
                $outputPaths[] = [
                    'salesChannelId' => $salesChannelId,
                    'themeHash' => $this->themePathBuilder->assemblePath($salesChannelId, $themeId),
                ];
            }

            // Serialize style FileCollection
            $styleData = [];
            foreach ($resolvedFiles['style'] as $file) {
                $styleData[] = [
                    'filepath' => $file->getFilepath(),
                    'resolveMapping' => $file->getResolveMapping() ?: (object) [],
                    'assetName' => $file->assetName,
                ];
            }

            $themes[] = [
                'themeId' => $themeId,
                'technicalName' => $technicalName,
                'domainUrl' => $domainUrl ?? '',
                'style' => $styleData,
                'outputPaths' => $outputPaths,
            ];

            $io->writeln(\sprintf(
                '  Theme <info>%s</info> (%s) → %d sales channel(s)',
                $technicalName,
                $themeId,
                \count($salesChannelIds),
            ));
            foreach ($outputPaths as $op) {
                $io->writeln(\sprintf('    public/theme/<comment>%s</comment>/css/all.css', $op['themeHash']));
            }
        }

        if (\count($themes) === 0) {
            $io->error('No active themes found');

            return self::FAILURE;
        }

        // Write JSON
        $data = ['themes' => $themes];
        $this->staticFileConfigDumper->dumpConfigInVar('sidworks-watch-themes.json', $data);

        $io->success(\sprintf(
            'Wrote %d theme(s) to var/sidworks-watch-themes.json',
            \count($themes),
        ));

        if ($input->getOption('prep-only')) {
            return self::SUCCESS;
        }

        // Start the file watcher with --skip-prep (prep is already done)
        $watchScript = \dirname(__DIR__, 2) . '/bin/watch.mjs';

        // Install node_modules if needed
        $pluginRoot = \dirname(__DIR__, 2);
        if (!is_dir($pluginRoot . '/node_modules/sass')) {
            $io->section('Installing dependencies...');
            $install = $this->findRuntime() === 'bun'
                ? new Process(['bun', 'install'], $pluginRoot)
                : new Process(['npm', 'install'], $pluginRoot);
            $install->setTimeout(120);
            $install->run(function (string $type, string $buffer) use ($output): void {
                $output->write($buffer);
            });
        }

        $runtime = $this->findRuntime();
        $io->section(\sprintf('Starting SCSS watcher via %s...', $runtime));

        $process = new Process([$runtime, $watchScript, '--skip-prep']);
        $process->setTimeout(null);
        $process->setTty(Process::isTtySupported());
        $process->run(function (string $type, string $buffer) use ($output): void {
            $output->write($buffer);
        });

        return $process->getExitCode() ?? self::SUCCESS;
    }

    private function getTechnicalName(string $themeId): ?string
    {
        $technicalName = null;

        do {
            $theme = $this->themeRepository->search(new Criteria([$themeId]), $this->context)->getEntities()->first();
            if (!$theme instanceof ThemeEntity) {
                break;
            }

            $technicalName = $theme->getTechnicalName();
            $parentThemeId = $theme->getParentThemeId();
            if ($parentThemeId !== null) {
                $themeId = $parentThemeId;
            }
        } while ($technicalName === null && $parentThemeId !== null);

        return $technicalName;
    }

    private function findRuntime(): string
    {
        foreach (['bun', 'node'] as $bin) {
            $check = new Process(['which', $bin]);
            $check->run();
            if ($check->isSuccessful()) {
                return $bin;
            }
        }

        throw new \RuntimeException('Neither bun nor node found. Install one of them to run the SCSS watcher.');
    }

    private function getDomainUrl(string $salesChannelId): ?string
    {
        $result = $this->themeRepository->search(
            (new Criteria())
                ->addFilter(new EqualsFilter('salesChannels.id', $salesChannelId))
                ->addAssociation('salesChannels.domains'),
            $this->context,
        )->getEntities()->first();

        if (!$result instanceof ThemeEntity) {
            return null;
        }

        $salesChannels = $result->getSalesChannels()?->filterByTypeId(Defaults::SALES_CHANNEL_TYPE_STOREFRONT);
        if ($salesChannels === null) {
            return null;
        }

        foreach ($salesChannels as $sc) {
            if ($sc->getId() !== $salesChannelId) {
                continue;
            }
            $domains = $sc->getDomains();
            if ($domains !== null && $domains->count() > 0) {
                return $domains->first()?->getUrl();
            }
        }

        return null;
    }
}
