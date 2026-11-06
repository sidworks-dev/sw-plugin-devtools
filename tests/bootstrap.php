<?php declare(strict_types=1);

$pluginRoot = dirname(__DIR__);
$autoloadPaths = [
    $pluginRoot . '/vendor/autoload.php',
    dirname(__DIR__, 4) . '/vendor/autoload.php',
];

foreach ($autoloadPaths as $autoloadPath) {
    if (is_file($autoloadPath)) {
        $loader = require $autoloadPath;
        $loader->addPsr4('Sidworks\\DevTools\\', $pluginRoot . '/src', true);

        return;
    }
}

throw new RuntimeException('Install Shopware dependencies before running the plugin tests.');
