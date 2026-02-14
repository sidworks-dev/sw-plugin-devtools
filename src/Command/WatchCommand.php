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
    description: 'Legacy wrapper for the unified storefront watcher',
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
        $this->addOption('prep-only', null, InputOption::VALUE_NONE, 'Deprecated: runs only bundle/feature/theme dump commands');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $application = $this->getApplication();

        if ($application === null) {
            $io->error('No application available');

            return self::FAILURE;
        }

        if ($input->getOption('prep-only')) {
            $io->warning('Option "--prep-only" is deprecated and only runs lightweight dumps now.');
            $application->find('bundle:dump')->run(new ArrayInput([]), $output);
            $application->find('feature:dump')->run(new ArrayInput([]), $output);
            $application->find('theme:dump')->run(new ArrayInput([]), $output);

            return self::SUCCESS;
        }

        $io->warning('Command "sidworks:watch" is deprecated. Forwarding to "bin/watch-storefront.sh".');

        $pluginRoot = \dirname(__DIR__, 2);
        $projectRoot = \dirname($pluginRoot, 3);
        $watchScript = $projectRoot . '/bin/watch-storefront.sh';

        if (!is_file($watchScript)) {
            $io->error(\sprintf('Cannot find watcher script: %s', $watchScript));

            return self::FAILURE;
        }

        $process = new Process([$watchScript, '--use-plugin-hot-proxy'], $projectRoot);
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
