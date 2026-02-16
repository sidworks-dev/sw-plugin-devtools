<?php declare(strict_types=1);

namespace Sidworks\DevTools\Command;

use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Component\Process\Process;

#[AsCommand(
    name: 'sidworks:watch-storefront',
    description: 'Optimized storefront watcher without shell wrapper',
)]
class WatchCommand extends Command
{
    protected function configure(): void
    {
        $this
            ->addOption('no-js', null, InputOption::VALUE_NONE, 'Disable JS compilation (core + plugins)')
            ->addOption('no-twig', null, InputOption::VALUE_NONE, 'Disable Twig watch/live reload feedback')
            ->addOption('no-scss', null, InputOption::VALUE_NONE, 'Disable SCSS compilation')
            ->addOption('open-browser', null, InputOption::VALUE_NONE, 'Auto-open browser on startup')
            ->addOption('theme-name', null, InputOption::VALUE_REQUIRED, 'Technical theme name passed to theme:dump')
            ->addOption('theme-id', null, InputOption::VALUE_REQUIRED, 'Theme ID passed to theme:dump')
            ->addOption('domain-url', null, InputOption::VALUE_REQUIRED, 'Sales channel domain URL passed to theme:dump')
            ->addOption('pick-theme', null, InputOption::VALUE_NONE, 'Force interactive theme:dump theme/domain picker');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $projectRoot = $this->resolveProjectRoot(__DIR__);
        $pluginRoot = \dirname(__DIR__, 2);
        $storefrontApp = $this->resolveStorefrontApp($projectRoot);
        $hotProxyScript = $this->resolveHotProxyScript($projectRoot, $pluginRoot);

        if (!is_dir($storefrontApp)) {
            $io->error(\sprintf('Storefront app not found: %s', $storefrontApp));

            return self::FAILURE;
        }

        if ($hotProxyScript === null || !is_file($hotProxyScript)) {
            $configuredPath = $this->env('SHOPWARE_STOREFRONT_HOT_PROXY_SCRIPT', '');
            if ($configuredPath !== '') {
                $io->error(\sprintf('Hot proxy script not found: %s', $configuredPath));
            } else {
                $io->error('Hot proxy script not found. Set SHOPWARE_STOREFRONT_HOT_PROXY_SCRIPT if the plugin is installed in a custom location.');
            }

            return self::FAILURE;
        }

        $nodeBinary = $this->resolveBinary('node');
        if ($nodeBinary === null) {
            $io->error('Node.js is required to run sidworks:watch-storefront');

            return self::FAILURE;
        }

        $packageManager = $this->selectPackageManager($io);
        $disableJs = (bool) $input->getOption('no-js');
        $disableTwig = (bool) $input->getOption('no-twig');
        $disableScss = (bool) $input->getOption('no-scss');
        $openBrowser = (bool) $input->getOption('open-browser');
        $themeName = $this->normalizeOptionalString($input->getOption('theme-name'));
        $themeId = $this->normalizeOptionalString($input->getOption('theme-id'));
        $domainUrl = $this->normalizeOptionalString($input->getOption('domain-url'));
        $pickThemeOption = (bool) $input->getOption('pick-theme');
        $canRunThemePicker = $input->isInteractive() && Process::isTtySupported();
        $hasExplicitThemeSelection = $themeName !== '' || $themeId !== '' || $domainUrl !== '';
        $pickTheme = $pickThemeOption || (!$hasExplicitThemeSelection && $canRunThemePicker);
        $scssEngine = $this->resolveScssEngine();

        if ($themeName !== '' && $themeId !== '') {
            $io->error('Use either --theme-name or --theme-id (not both).');

            return self::FAILURE;
        }

        if ($domainUrl !== '' && $themeId === '') {
            $io->error('--domain-url requires --theme-id. Use --pick-theme for interactive theme/domain selection.');

            return self::FAILURE;
        }

        if ($pickThemeOption && ($themeName !== '' || $themeId !== '' || $domainUrl !== '')) {
            $io->error('--pick-theme cannot be combined with --theme-name, --theme-id, or --domain-url.');

            return self::FAILURE;
        }

        if ($pickThemeOption && !$canRunThemePicker) {
            $io->error('--pick-theme requires an interactive TTY terminal.');

            return self::FAILURE;
        }

        if (!\in_array($scssEngine, ['webpack', 'sass-cli'], true)) {
            $io->error('Invalid SHOPWARE_STOREFRONT_SCSS_ENGINE value. Use "webpack" or "sass-cli".');

            return self::FAILURE;
        }

        $hotEnvironment = $this->buildHotEnvironment(
            $projectRoot,
            $scssEngine,
            $disableJs,
            $disableTwig,
            $disableScss,
            $openBrowser
        );

        $this->renderStartupOverview($io, $projectRoot, $packageManager, $storefrontApp, $hotProxyScript, $hotEnvironment);

        if (!is_dir($storefrontApp . '/node_modules/webpack-dev-server')) {
            $io->writeln('Installing storefront dependencies');
            $installExitCode = $this->runPackageInstall($packageManager, $storefrontApp, $projectRoot, $output, $input);
            if ($installExitCode !== 0) {
                return $installExitCode;
            }
        }

        $autoInstallSassEmbedded = $this->shouldAutoInstallSassEmbedded(
            ($hotEnvironment['SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED'] ?? '1') === '1',
            $disableScss
        );

        if ($autoInstallSassEmbedded) {
            $sassEmbeddedExitCode = $this->ensureSassEmbedded($packageManager, $storefrontApp, $projectRoot, $output, $input, $io);
            if ($sassEmbeddedExitCode !== 0) {
                $io->warning('sass-embedded installation failed. Watcher continues with sass fallback (slower SCSS builds).');
            }
        }

        $prepExitCode = $this->runPrepCommands($output, $input, $projectRoot, $themeName, $themeId, $domainUrl, $pickTheme);
        if ($prepExitCode !== 0) {
            return $prepExitCode;
        }

        if (!$disableJs) {
            $pluginInstallExitCode = $this->installPluginStorefrontDependencies($packageManager, $projectRoot, $output, $input, $io);
            if ($pluginInstallExitCode !== 0) {
                return $pluginInstallExitCode;
            }
        }

        $watchProcess = new Process([$nodeBinary, $hotProxyScript], $projectRoot, $hotEnvironment, null, null);

        return $this->runProcess($watchProcess, $output, $input);
    }

    private function runPrepCommands(
        OutputInterface $output,
        InputInterface $input,
        string $projectRoot,
        string $themeName,
        string $themeId,
        string $domainUrl,
        bool $pickTheme
    ): int {
        $hasThemeSelection = $themeName !== '' || $themeId !== '' || $domainUrl !== '' || $pickTheme;
        if (is_file($projectRoot . '/var/theme-files.json') && !$hasThemeSelection) {
            return 0;
        }

        $themeDumpArguments = ['theme:dump'];
        if ($themeName !== '') {
            $themeDumpArguments[] = '--theme-name=' . $themeName;
        }

        if ($themeId !== '') {
            $themeDumpArguments[] = $themeId;
        }

        if ($domainUrl !== '') {
            $themeDumpArguments[] = $domainUrl;
        }

        return $this->runConsoleCommand($themeDumpArguments, $projectRoot, $output, $input, !$pickTheme);
    }

    private function runConsoleCommand(
        array $arguments,
        string $projectRoot,
        OutputInterface $output,
        InputInterface $input,
        bool $nonInteractive = true
    ): int {
        if (
            $nonInteractive
            && !\in_array('--no-interaction', $arguments, true)
            && !\in_array('-n', $arguments, true)
        ) {
            $arguments[] = '--no-interaction';
        }

        $process = new Process([PHP_BINARY, $projectRoot . '/bin/console', ...$arguments], $projectRoot, null, null, null);

        return $this->runProcess($process, $output, $input);
    }

    private function renderStartupOverview(
        SymfonyStyle $io,
        string $projectRoot,
        string $packageManager,
        string $storefrontApp,
        string $hotProxyScript,
        array $hotEnvironment
    ): void {
        $disableJs = ($hotEnvironment['SHOPWARE_STOREFRONT_DISABLE_JS'] ?? '0') === '1';
        $disableTwig = ($hotEnvironment['SHOPWARE_STOREFRONT_DISABLE_TWIG'] ?? '0') === '1';
        $disableScss = ($hotEnvironment['SHOPWARE_STOREFRONT_DISABLE_SCSS'] ?? '0') === '1';

        $io->title('Sidworks Storefront Watcher');
        $io->section('Runtime');
        $io->definitionList(
            ['Package manager' => \sprintf('<info>%s</info>', $packageManager)],
            ['Storefront app' => \sprintf('<comment>%s</comment>', $this->formatPathForDisplay($storefrontApp, $projectRoot))],
            ['Hot proxy runtime' => \sprintf('<comment>%s</comment>', $this->formatPathForDisplay($hotProxyScript, $projectRoot))],
        );

        $io->section('Build Profile');
        $io->definitionList(
            ['Core-only hot mode' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_HOT_CORE_ONLY'])],
            ['Disable JS' => $disableJs ? '<comment>yes</comment>' : '<info>no</info>'],
            ['Disable Twig' => $disableTwig ? '<comment>yes</comment>' : '<info>no</info>'],
            ['Disable SCSS' => $disableScss ? '<comment>yes</comment>' : '<info>no</info>'],
            ['SCSS engine' => \sprintf('<info>%s</info>', $hotEnvironment['SHOPWARE_STOREFRONT_SCSS_ENGINE'])],
            ['Auto-install sass-embedded' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_AUTO_INSTALL_SASS_EMBEDDED'])],
            ['Twig watch mode' => \sprintf('<info>%s</info>', $hotEnvironment['SHOPWARE_STOREFRONT_TWIG_WATCH_MODE'])],
            ['Build parallelism' => \sprintf('<info>%s</info>', $hotEnvironment['SHOPWARE_BUILD_PARALLELISM'])],
            ['JS source maps' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_JS_SOURCE_MAP'])],
            ['SCSS source maps' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP'])],
            ['Skip PostCSS' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_SKIP_POSTCSS'])],
            ['Use sass-embedded' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED'])],
            ['Auto-open browser' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_OPEN_BROWSER'])],
        );
    }

    private function runPackageInstall(
        string $packageManager,
        string $path,
        string $projectRoot,
        OutputInterface $output,
        InputInterface $input
    ): int {
        $command = $packageManager === 'bun'
            ? ['bun', 'install', '--cwd', $path]
            : ['npm', 'install', '--prefix', $path, '--prefer-offline', '--no-audit', '--fund=false'];

        $process = new Process($command, $projectRoot, null, null, null);

        return $this->runProcess($process, $output, $input);
    }

    private function ensureSassEmbedded(
        string $packageManager,
        string $storefrontApp,
        string $projectRoot,
        OutputInterface $output,
        InputInterface $input,
        SymfonyStyle $io
    ): int {
        if ($this->hasSassEmbedded($storefrontApp)) {
            return 0;
        }

        $io->writeln('Installing missing <info>sass-embedded</info> for storefront watcher');

        $command = $packageManager === 'bun'
            ? ['bun', 'add', '-d', 'sass-embedded', '--cwd', $storefrontApp]
            : ['npm', 'install', '--prefix', $storefrontApp, '--save-dev', 'sass-embedded', '--prefer-offline', '--no-audit', '--fund=false'];

        $process = new Process($command, $projectRoot, null, null, null);
        $exitCode = $this->runProcess($process, $output, $input);

        if ($exitCode === 0 && $this->hasSassEmbedded($storefrontApp)) {
            $io->success('sass-embedded installed');

            return 0;
        }

        return $exitCode !== 0 ? $exitCode : 1;
    }

    private function installPluginStorefrontDependencies(
        string $packageManager,
        string $projectRoot,
        OutputInterface $output,
        InputInterface $input,
        SymfonyStyle $io
    ): int {
        $pluginsPath = $projectRoot . '/var/plugins.json';
        if (!is_file($pluginsPath)) {
            return 0;
        }

        $content = file_get_contents($pluginsPath);
        if ($content === false) {
            return 0;
        }

        $configs = json_decode($content, true);
        if (!\is_array($configs)) {
            return 0;
        }

        foreach ($configs as $config) {
            if (!\is_array($config)) {
                continue;
            }

            $technicalName = \is_string($config['technicalName'] ?? null) ? $config['technicalName'] : '';
            if ($technicalName === '' || $technicalName === 'storefront') {
                continue;
            }

            $storefrontPath = \is_string($config['storefront']['path'] ?? null) ? $config['storefront']['path'] : '';
            if ($storefrontPath === '') {
                continue;
            }

            $basePath = \is_string($config['basePath'] ?? null) ? $config['basePath'] : '';
            $sourcePath = $this->resolvePath($projectRoot, $basePath . $storefrontPath);
            $packagePath = \dirname($sourcePath);

            if (!is_file($packagePath . '/package.json') || is_dir($packagePath . '/node_modules')) {
                continue;
            }

            $skipVariable = 'SKIP_' . strtoupper(str_replace('-', '_', $technicalName));
            $skipVariableValue = getenv($skipVariable);
            if ($skipVariableValue !== false && $skipVariableValue !== '') {
                continue;
            }

            $io->writeln(\sprintf('Installing dependencies for %s', $technicalName));
            $exitCode = $this->runPackageInstall($packageManager, $packagePath, $projectRoot, $output, $input);
            if ($exitCode !== 0) {
                return $exitCode;
            }
        }

        return 0;
    }

    private function runProcess(Process $process, OutputInterface $output, InputInterface $input): int
    {
        $process->setTimeout(null);

        if ($input->isInteractive() && Process::isTtySupported()) {
            $process->setTty(true);
            $process->run();

            return $process->getExitCode() ?? 0;
        }

        $process->run(static function (string $type, string $buffer) use ($output): void {
            $output->write($buffer);
        });

        return $process->getExitCode() ?? 0;
    }

    private function selectPackageManager(SymfonyStyle $io): string
    {
        $preferBun = $this->env('SHOPWARE_STOREFRONT_WATCH_PM', '') === 'bun';

        if ($preferBun) {
            if ($this->resolveBinary('bun') !== null) {
                return 'bun';
            }

            $io->warning('Requested Bun but it is not available. Falling back to npm.');
        }

        return 'npm';
    }

    private function buildHotEnvironment(
        string $projectRoot,
        string $scssEngine,
        bool $disableJs,
        bool $disableTwig,
        bool $disableScss,
        bool $openBrowser
    ): array {
        $buildParallelism = $this->env('SHOPWARE_BUILD_PARALLELISM', '');
        if ($buildParallelism === '') {
            $buildParallelism = (string) max(1, $this->detectCpuCount() - 1);
        }

        $twigWatchMode = $disableTwig ? 'off' : 'narrow';
        $useSassEmbedded = $this->env('SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED', '1');
        $scssSourceMapEnabled = $this->env(
            'SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP',
            $scssEngine === 'sass-cli' ? '1' : '0'
        );

        $environment = [
            'PROJECT_ROOT' => $projectRoot,
            'NODE_ENV' => $this->env('NODE_ENV', 'development'),
            'MODE' => $this->env('MODE', 'hot'),
            'NPM_CONFIG_FUND' => 'false',
            'NPM_CONFIG_AUDIT' => 'false',
            'NPM_CONFIG_UPDATE_NOTIFIER' => 'false',
            'SHOPWARE_BUILD_PARALLELISM' => $buildParallelism,
            'SHOPWARE_STOREFRONT_DEV_CACHE' => $this->env('SHOPWARE_STOREFRONT_DEV_CACHE', '1'),
            'SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED' => $useSassEmbedded,
            'SHOPWARE_STOREFRONT_HOT_CORE_ONLY' => $disableJs ? '1' : '0',
            'SHOPWARE_STOREFRONT_TWIG_WATCH_MODE' => $twigWatchMode,
            'SHOPWARE_STOREFRONT_JS_SOURCE_MAP' => $this->env('SHOPWARE_STOREFRONT_JS_SOURCE_MAP', '0'),
            'SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP' => $scssSourceMapEnabled,
            'SHOPWARE_STOREFRONT_SCSS_ENGINE' => $scssEngine,
            'SHOPWARE_STOREFRONT_SKIP_POSTCSS' => '1',
            'SHOPWARE_STOREFRONT_SASS_SILENCE_DEPRECATIONS' => '1',
            'SHOPWARE_STOREFRONT_OPEN_BROWSER' => $openBrowser ? '1' : '0',
            'SHOPWARE_STOREFRONT_DISABLE_JS' => $disableJs ? '1' : '0',
            'SHOPWARE_STOREFRONT_DISABLE_TWIG' => $disableTwig ? '1' : '0',
            'SHOPWARE_STOREFRONT_DISABLE_SCSS' => $disableScss ? '1' : '0',
        ];

        $environment['SHOPWARE_STOREFRONT_AUTO_INSTALL_SASS_EMBEDDED'] = $this->shouldAutoInstallSassEmbedded(
            $useSassEmbedded === '1',
            $disableScss
        ) ? '1' : '0';

        if ($twigWatchMode === 'narrow' || $twigWatchMode === 'off') {
            $environment['SHOPWARE_STOREFRONT_SKIP_EXTENSION_TWIG_WATCH'] = '1';
        }

        return $environment;
    }

    private function shouldAutoInstallSassEmbedded(bool $useSassEmbeddedEnabled, bool $disableScss): bool
    {
        if ($disableScss || !$useSassEmbeddedEnabled) {
            return false;
        }

        return $this->env('SHOPWARE_STOREFRONT_AUTO_INSTALL_SASS_EMBEDDED', '1') === '1';
    }

    private function hasSassEmbedded(string $storefrontApp): bool
    {
        return is_dir($storefrontApp . '/node_modules/sass-embedded');
    }

    private function detectCpuCount(): int
    {
        $contents = @file_get_contents('/proc/cpuinfo');
        if (!$contents) {
            return 2;
        }

        preg_match_all('/^processor\s*:/m', $contents, $matches);

        return !empty($matches[0]) ? \count($matches[0]) : 2;
    }

    private function resolveStorefrontApp(string $projectRoot): string
    {
        $platformStorefrontApp = $projectRoot . '/vendor/shopware/platform/src/Storefront/Resources/app/storefront';
        if (is_dir($platformStorefrontApp)) {
            return $platformStorefrontApp;
        }

        return $projectRoot . '/vendor/shopware/storefront/Resources/app/storefront';
    }

    private function resolveHotProxyScript(string $projectRoot, string $pluginRoot): ?string
    {
        $configuredPath = $this->env('SHOPWARE_STOREFRONT_HOT_PROXY_SCRIPT', '');
        if ($configuredPath !== '') {
            return $configuredPath;
        }

        $candidates = [
            $pluginRoot . '/bin/storefront-hot-proxy/start-hot-reload.js',
            $projectRoot . '/custom/plugins/SidworksDevTools/bin/storefront-hot-proxy/start-hot-reload.js',
            $projectRoot . '/vendor/sidworks/sw-plugin-devtools/bin/storefront-hot-proxy/start-hot-reload.js',
        ];

        $globCandidates = glob($projectRoot . '/vendor/*/sw-plugin-devtools/bin/storefront-hot-proxy/start-hot-reload.js');
        if (\is_array($globCandidates) && $globCandidates !== []) {
            $candidates = array_merge($candidates, $globCandidates);
        }

        foreach ($candidates as $candidate) {
            if (\is_string($candidate) && is_file($candidate)) {
                return $candidate;
            }
        }

        return null;
    }

    private function resolveProjectRoot(string $startDirectory): string
    {
        $current = $startDirectory;

        while (true) {
            if (is_dir($current . '/vendor/shopware') && is_dir($current . '/var')) {
                return $current;
            }

            $parent = \dirname($current);
            if ($parent === $current) {
                break;
            }

            $current = $parent;
        }

        throw new \RuntimeException('Could not resolve project root for sidworks:watch-storefront');
    }

    private function resolveBinary(string $binary): ?string
    {
        $pathValue = getenv('PATH');
        if ($pathValue === false || $pathValue === '') {
            return null;
        }

        foreach (explode(PATH_SEPARATOR, $pathValue) as $directory) {
            $candidate = rtrim($directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $binary;
            if (is_file($candidate) && is_executable($candidate)) {
                return $candidate;
            }
        }

        return null;
    }

    private function resolvePath(string $projectRoot, string $path): string
    {
        if ($path === '') {
            return $projectRoot;
        }

        if ($path[0] === DIRECTORY_SEPARATOR || preg_match('/^[A-Za-z]:\\\\/', $path) === 1) {
            return $path;
        }

        return $projectRoot . '/' . ltrim($path, '/');
    }

    private function env(string $key, string $default): string
    {
        $value = getenv($key);
        if ($value === false || $value === '') {
            return $default;
        }

        return (string) $value;
    }

    private function resolveScssEngine(): string
    {
        $envValue = strtolower($this->env('SHOPWARE_STOREFRONT_SCSS_ENGINE', ''));

        return $envValue !== '' ? $envValue : 'sass-cli';
    }

    private function yesNo(string $value): string
    {
        return $value === '1' ? '<info>yes</info>' : '<comment>no</comment>';
    }

    private function formatPathForDisplay(string $path, string $projectRoot): string
    {
        $normalizedPath = str_replace('\\', '/', $path);
        $normalizedProjectRoot = rtrim(str_replace('\\', '/', $projectRoot), '/');

        if ($normalizedProjectRoot !== '' && str_starts_with($normalizedPath, $normalizedProjectRoot . '/')) {
            return '<project>/' . ltrim(substr($normalizedPath, \strlen($normalizedProjectRoot)), '/');
        }

        return $normalizedPath;
    }

    private function normalizeOptionalString(mixed $value): string
    {
        if (!\is_string($value)) {
            return '';
        }

        return trim($value);
    }
}
