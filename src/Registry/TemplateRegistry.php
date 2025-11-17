<?php declare(strict_types=1);

namespace Sidworks\DevTools\Registry;

class TemplateRegistry
{
    private static array $items = [];

    public static function add(array $data): void
    {
        self::$items[] = $data;
    }

    public static function all(): array
    {
        return self::$items;
    }

    public static function clear(): void
    {
        self::$items = [];
    }
}
