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
    name: 'sidworks:watch',
    description: 'Optimized storefront watcher without shell wrapper',
)]
class WatchCommand extends Command
{
    protected function configure(): void
    {
        $this
            ->addOption('theme-name', null, InputOption::VALUE_REQUIRED, 'Theme name for theme:dump')
            ->addOption('skip-bundle-dump', null, InputOption::VALUE_NONE, 'Skip "bin/console bundle:dump"')
            ->addOption('skip-feature-dump', null, InputOption::VALUE_NONE, 'Skip "bin/console feature:dump"')
            ->addOption('skip-theme-compile', null, InputOption::VALUE_NONE, 'Skip "bin/console theme:compile --active-only"')
            ->addOption('skip-theme-dump', null, InputOption::VALUE_NONE, 'Skip "bin/console theme:dump"')
            ->addOption('skip-plugin-install', null, InputOption::VALUE_NONE, 'Skip plugin storefront dependency checks')
            ->addOption('skip-install', null, InputOption::VALUE_NONE, 'Skip storefront dependency checks')
            ->addOption('use-bun', null, InputOption::VALUE_NONE, 'Prefer Bun for dependency install')
            ->addOption('use-npm', null, InputOption::VALUE_NONE, 'Force npm for dependency install')
            ->addOption('core-only-hot', null, InputOption::VALUE_NONE, 'Compile only core storefront in hot mode')
            ->addOption('full-twig-watch', null, InputOption::VALUE_NONE, 'Watch broad Twig scope (slower)')
            ->addOption('js-source-map', null, InputOption::VALUE_NONE, 'Enable JS source maps in hot mode')
            ->addOption('scss-source-map', null, InputOption::VALUE_NONE, 'Enable SCSS source maps in hot mode')
            ->addOption('skip-postcss', null, InputOption::VALUE_NONE, 'Skip PostCSS in hot mode')
            ->addOption('show-sass-deprecations', null, InputOption::VALUE_NONE, 'Show Sass deprecation warnings')
            ->addOption('no-open-browser', null, InputOption::VALUE_NONE, 'Disable auto-open browser')
            ->addOption('build-parallelism', null, InputOption::VALUE_REQUIRED, 'Override SHOPWARE_BUILD_PARALLELISM')
            ->addOption('prep-only', null, InputOption::VALUE_NONE, 'Run prep commands only, do not start watcher');
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
            $io->error('Node.js is required to run sidworks:watch');

            return self::FAILURE;
        }

        $packageManager = $this->selectPackageManager($input, $io);
        $hotEnvironment = $this->buildHotEnvironment($input, $projectRoot);

        $this->renderStartupOverview($io, $projectRoot, $packageManager, $storefrontApp, $hotProxyScript, $hotEnvironment);

        if (!$input->getOption('skip-install') && !is_dir($storefrontApp . '/node_modules/webpack-dev-server')) {
            $io->writeln('Installing storefront dependencies');
            $installExitCode = $this->runPackageInstall($packageManager, $storefrontApp, $projectRoot, $output, $input);
            if ($installExitCode !== 0) {
                return $installExitCode;
            }
        }

        $prepExitCode = $this->runPrepCommands($input, $output, $projectRoot);
        if ($prepExitCode !== 0) {
            return $prepExitCode;
        }

        if ($input->getOption('prep-only')) {
            return self::SUCCESS;
        }

        if (!$input->getOption('skip-plugin-install')) {
            $pluginInstallExitCode = $this->installPluginStorefrontDependencies($packageManager, $projectRoot, $output, $input, $io);
            if ($pluginInstallExitCode !== 0) {
                return $pluginInstallExitCode;
            }
        }

        $watchProcess = new Process([$nodeBinary, $hotProxyScript], $projectRoot, $hotEnvironment, null, null);
        return $this->runProcess($watchProcess, $output, $input);
    }

    private function runPrepCommands(InputInterface $input, OutputInterface $output, string $projectRoot): int
    {
        if (!$input->getOption('skip-bundle-dump')) {
            $exitCode = $this->runConsoleCommand(['bundle:dump'], $projectRoot, $output, $input);
            if ($exitCode !== 0) {
                return $exitCode;
            }
        }

        if (!$input->getOption('skip-feature-dump')) {
            $exitCode = $this->runConsoleCommand(['feature:dump'], $projectRoot, $output, $input);
            if ($exitCode !== 0) {
                return $exitCode;
            }
        }

        if (!$input->getOption('skip-theme-compile')) {
            $exitCode = $this->runConsoleCommand(['theme:compile', '--active-only'], $projectRoot, $output, $input);
            if ($exitCode !== 0) {
                return $exitCode;
            }
        }

        if (!$input->getOption('skip-theme-dump')) {
            $command = ['theme:dump'];
            $themeName = $input->getOption('theme-name');
            if (\is_string($themeName) && $themeName !== '') {
                $command[] = '--theme-name=' . $themeName;
            }

            return $this->runConsoleCommand($command, $projectRoot, $output, $input);
        }

        return 0;
    }

    private function renderStartupOverview(
        SymfonyStyle $io,
        string $projectRoot,
        string $packageManager,
        string $storefrontApp,
        string $hotProxyScript,
        array $hotEnvironment
    ): void {
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
            ['Twig watch mode' => \sprintf('<info>%s</info>', $hotEnvironment['SHOPWARE_STOREFRONT_TWIG_WATCH_MODE'])],
            ['Build parallelism' => \sprintf('<info>%s</info>', $hotEnvironment['SHOPWARE_BUILD_PARALLELISM'])],
            ['JS source maps' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_JS_SOURCE_MAP'])],
            ['SCSS source maps' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP'])],
            ['Skip PostCSS' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_SKIP_POSTCSS'])],
            ['Use sass-embedded' => $this->yesNo($hotEnvironment['SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED'])],
        );
    }

    private function runConsoleCommand(array $arguments, string $projectRoot, OutputInterface $output, InputInterface $input): int
    {
        if (!\in_array('--no-interaction', $arguments, true) && !\in_array('-n', $arguments, true)) {
            $arguments[] = '--no-interaction';
        }

        $process = new Process([PHP_BINARY, $projectRoot . '/bin/console', ...$arguments], $projectRoot, null, null, null);
        return $this->runProcess($process, $output, $input);
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

    private function selectPackageManager(InputInterface $input, SymfonyStyle $io): string
    {
        if ($input->getOption('use-npm')) {
            return 'npm';
        }

        $preferBun = $input->getOption('use-bun');
        if (!$preferBun) {
            $preferBun = $this->env('SHOPWARE_STOREFRONT_WATCH_PM', '') === 'bun';
        }

        if ($preferBun) {
            if ($this->resolveBinary('bun') !== null) {
                return 'bun';
            }

            $io->warning('Requested Bun but it is not available. Falling back to npm.');
        }

        return 'npm';
    }

    private function buildHotEnvironment(InputInterface $input, string $projectRoot): array
    {
        $buildParallelism = $this->env('SHOPWARE_BUILD_PARALLELISM', '');
        if ($buildParallelism === '') {
            $buildParallelism = (string) max(1, $this->detectCpuCount() - 1);
        }

        $overrideParallelism = $input->getOption('build-parallelism');
        if (\is_string($overrideParallelism) && ctype_digit($overrideParallelism) && (int) $overrideParallelism > 0) {
            $buildParallelism = $overrideParallelism;
        }

        $twigWatchMode = $input->getOption('full-twig-watch')
            ? 'full'
            : $this->env('SHOPWARE_STOREFRONT_TWIG_WATCH_MODE', 'narrow');

        $environment = [
            'PROJECT_ROOT' => $projectRoot,
            'NODE_ENV' => $this->env('NODE_ENV', 'development'),
            'MODE' => $this->env('MODE', 'hot'),
            'NPM_CONFIG_FUND' => 'false',
            'NPM_CONFIG_AUDIT' => 'false',
            'NPM_CONFIG_UPDATE_NOTIFIER' => 'false',
            'SHOPWARE_BUILD_PARALLELISM' => $buildParallelism,
            'SHOPWARE_STOREFRONT_DEV_CACHE' => $this->env('SHOPWARE_STOREFRONT_DEV_CACHE', '1'),
            'SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED' => $this->env('SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED', '1'),
            'SHOPWARE_STOREFRONT_HOT_CORE_ONLY' => $input->getOption('core-only-hot')
                ? '1'
                : $this->env('SHOPWARE_STOREFRONT_HOT_CORE_ONLY', '0'),
            'SHOPWARE_STOREFRONT_TWIG_WATCH_MODE' => $twigWatchMode,
            'SHOPWARE_STOREFRONT_JS_SOURCE_MAP' => $input->getOption('js-source-map')
                ? '1'
                : $this->env('SHOPWARE_STOREFRONT_JS_SOURCE_MAP', '0'),
            'SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP' => $input->getOption('scss-source-map')
                ? '1'
                : $this->env('SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP', '0'),
            'SHOPWARE_STOREFRONT_SKIP_POSTCSS' => $input->getOption('skip-postcss')
                ? '1'
                : $this->env('SHOPWARE_STOREFRONT_SKIP_POSTCSS', '0'),
            'SHOPWARE_STOREFRONT_SASS_SILENCE_DEPRECATIONS' => $input->getOption('show-sass-deprecations')
                ? '0'
                : $this->env('SHOPWARE_STOREFRONT_SASS_SILENCE_DEPRECATIONS', '1'),
            'SHOPWARE_STOREFRONT_OPEN_BROWSER' => $input->getOption('no-open-browser')
                ? '0'
                : $this->env('SHOPWARE_STOREFRONT_OPEN_BROWSER', '0'),
        ];

        if ($twigWatchMode === 'narrow') {
            $environment['SHOPWARE_STOREFRONT_SKIP_EXTENSION_TWIG_WATCH'] = '1';
        }

        return $environment;
    }

    private function detectCpuCount(): int
    {
        $cpuInfoPath = '/proc/cpuinfo';
        if (!is_file($cpuInfoPath)) {
            return 2;
        }

        $contents = file_get_contents($cpuInfoPath);
        if ($contents === false) {
            return 2;
        }

        preg_match_all('/^processor\s*:/m', $contents, $matches);
        $count = \is_array($matches[0] ?? null) ? \count($matches[0]) : 0;

        return $count > 0 ? $count : 2;
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
        $directory = $startDirectory;
        $rootDirectory = \dirname($directory);

        while ($directory !== $rootDirectory) {
            if (is_dir($directory . '/vendor/shopware') && is_dir($directory . '/var')) {
                return $directory;
            }

            $directory = $rootDirectory;
            $rootDirectory = \dirname($directory);
        }

        throw new \RuntimeException('Could not resolve project root for sidworks:watch');
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

    private function yesNo(string $value): string
    {
        return $value === '1' ? '<info>yes</info>' : '<comment>no</comment>';
    }

    private function formatPathForDisplay(string $path, string $projectRoot): string
    {
        $normalizedPath = str_replace('\\', '/', $path);
        $normalizedProjectRoot = rtrim(str_replace('\\', '/', $projectRoot), '/');

        if ($normalizedProjectRoot !== '' && str_starts_with($normalizedPath, $normalizedProjectRoot . '/')) {
            return '<project>/' . ltrim(substr($normalizedPath, strlen($normalizedProjectRoot)), '/');
        }

        return $normalizedPath;
    }
}
