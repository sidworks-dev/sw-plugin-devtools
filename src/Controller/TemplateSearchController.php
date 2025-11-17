<?php declare(strict_types=1);

namespace Sidworks\DevTools\Controller;

use Sidworks\DevTools\Service\ConfigService;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

class TemplateSearchController extends AbstractController
{
    private string $projectDir;
    private bool $debugMode;
    private ConfigService $configService;

    public function __construct(string $projectDir, bool $debugMode, ConfigService $configService)
    {
        $this->projectDir = $projectDir;
        $this->debugMode = $debugMode;
        $this->configService = $configService;
    }

    public function findLineInTemplate(Request $request): JsonResponse
    {
        // Security: Only allow in debug mode and when plugin is enabled
        if (!$this->debugMode || !$this->configService->isEnabled()) {
            return new JsonResponse(['error' => 'Not available in production'], 403);
        }

        $data = json_decode($request->getContent(), true);
        $filePath = $data['filePath'] ?? null;
        $searchClasses = $data['searchClasses'] ?? [];
        $searchId = $data['searchId'] ?? null;
        $searchTag = $data['searchTag'] ?? null;
        $blockStartLine = $data['blockStartLine'] ?? 0;
        $parentClasses = $data['parentClasses'] ?? [];

        if (!$filePath) {
            return new JsonResponse(['error' => 'Missing filePath'], 400);
        }

        // Security: Validate search classes (max 5 classes)
        if (!is_array($searchClasses) || count($searchClasses) > 5) {
            return new JsonResponse(['error' => 'Invalid searchClasses'], 400);
        }

        // Security: Validate each class name
        foreach ($searchClasses as $className) {
            if (!is_string($className) || strlen($className) > 100 || !preg_match('/^[\w-]+$/', $className)) {
                return new JsonResponse(['error' => 'Invalid class name'], 400);
            }
        }

        // Security: Validate search ID
        if ($searchId && (strlen($searchId) > 100 || !preg_match('/^[\w-]+$/', $searchId))) {
            return new JsonResponse(['error' => 'Invalid search ID'], 400);
        }

        // Security: Validate search tag
        if ($searchTag && (strlen($searchTag) > 20 || !preg_match('/^[a-z]+$/i', $searchTag))) {
            return new JsonResponse(['error' => 'Invalid search tag'], 400);
        }

        // Security: Validate parent classes (max 5 parent levels, max 10 classes per parent)
        if (!is_array($parentClasses) || count($parentClasses) > 5) {
            return new JsonResponse(['error' => 'Invalid parentClasses'], 400);
        }
        foreach ($parentClasses as $parentClassList) {
            if (!is_array($parentClassList) || count($parentClassList) > 10) {
                return new JsonResponse(['error' => 'Invalid parent class list'], 400);
            }
            foreach ($parentClassList as $className) {
                if (!is_string($className) || strlen($className) > 100 || !preg_match('/^[\w-]+$/', $className)) {
                    return new JsonResponse(['error' => 'Invalid parent class name'], 400);
                }
            }
        }

        $projectDir = $this->projectDir;

        // If path starts with /Users or /home (local path), extract relative path
        if (preg_match('#^/(?:Users|home)/[^/]+/[^/]+/[^/]+/(.+)$#', $filePath, $matches)) {
            $relativePath = $matches[1];
            $realPath = $projectDir . '/' . $relativePath;
        } else {
            $realPath = $filePath;
        }

        // Security: Ensure path is within project directory (prevent directory traversal)
        $realPath = realpath($realPath);
        if (!$realPath || strpos($realPath, realpath($projectDir)) !== 0) {
            return new JsonResponse(['error' => 'Access denied'], 403);
        }

        // Security: Only allow reading template files
        if (!preg_match('/\.(twig|html\.twig)$/', $realPath)) {
            return new JsonResponse(['error' => 'Only template files allowed'], 403);
        }

        if (!file_exists($realPath)) {
            return new JsonResponse(['error' => 'File not found'], 404);
        }

        try {
            $lines = file($realPath, FILE_IGNORE_NEW_LINES);
            if ($lines === false) {
                return new JsonResponse(['error' => 'Could not read file'], 500);
            }

            // Search for the element starting from block start line
            $startSearch = max(0, $blockStartLine - 1);

            // Pre-calculate all search patterns to avoid repeated work
            $exactIdPattern = $searchId ? 'id=["\']' . preg_quote($searchId, '/') . '["\']' : null;
            $partialIdPattern = null;
            if ($searchId) {
                $staticParts = preg_split('/[0-9\-_]+$/', $searchId, -1, PREG_SPLIT_NO_EMPTY);
                if (!empty($staticParts) && strlen($staticParts[0]) >= 8) {
                    $partialIdPattern = 'id=["\'][^"\']*' . preg_quote($staticParts[0], '/');
                }
            }

            // Pre-build class search patterns (from most to least specific)
            $classPatterns = [];
            if (!empty($searchClasses)) {
                for ($numClasses = count($searchClasses); $numClasses >= 1; $numClasses--) {
                    $classPatterns[] = array_slice($searchClasses, 0, $numClasses);
                }
            }

            // Pre-build partial class prefix patterns
            $prefixPatterns = [];
            if (!empty($searchClasses)) {
                foreach ($searchClasses as $className) {
                    if (strpos($className, '-') !== false) {
                        $parts = explode('-', $className);
                        for ($prefixLength = count($parts) - 1; $prefixLength >= 1; $prefixLength--) {
                            $prefix = implode('-', array_slice($parts, 0, $prefixLength)) . '-';
                            $prefixPatterns[] = [
                                'prefix' => $prefix,
                                'pattern' => 'class=["\'][^"\']*' . preg_quote($prefix, '/') . '\\{\\{'
                            ];
                        }
                    }
                }
            }

            // Pre-build parent class patterns for context matching
            // Start with closest parent (index 0) and work outward
            $parentContextPatterns = [];
            if (!empty($parentClasses)) {
                for ($parentLevel = 0; $parentLevel < count($parentClasses); $parentLevel++) {
                    $parentClassList = $parentClasses[$parentLevel];
                    if (!empty($parentClassList)) {
                        $parentContextPatterns[] = [
                            'level' => $parentLevel,
                            'classes' => $parentClassList
                        ];
                    }
                }
            }

            // SINGLE PASS through the file - check all patterns
            $bestMatch = null;
            $bestPriority = 999;

            for ($i = $startSearch; $i < count($lines); $i++) {
                $line = $lines[$i];

                // PRIORITY 1: Exact ID match
                if ($exactIdPattern && preg_match('/' . $exactIdPattern . '/i', $line)) {
                    return new JsonResponse([
                        'found' => true,
                        'line' => $i + 1,
                        'content' => trim($line),
                        'matchedPattern' => 'id="' . $searchId . '"'
                    ]);
                }

                // PRIORITY 2: Partial ID match
                if ($bestPriority > 2 && $partialIdPattern && preg_match('/' . $partialIdPattern . '/i', $line)) {
                    $bestMatch = [
                        'found' => true,
                        'line' => $i + 1,
                        'content' => trim($line),
                        'matchedPattern' => 'id="...' . $staticParts[0] . '..."'
                    ];
                    $bestPriority = 2;
                }

                // PRIORITY 3: Class matches (try from most to least specific)
                if ($bestPriority > 3) {
                    foreach ($classPatterns as $classesToSearch) {
                        $allClassesFound = true;
                        foreach ($classesToSearch as $className) {
                            if (!preg_match('/class=["\'](?:[^"\']* )?' . preg_quote($className, '/') . '(?:\s|["\']|\{)/i', $line)) {
                                $allClassesFound = false;
                                break;
                            }
                        }
                        if ($allClassesFound) {
                            // If we have parent context patterns, try to verify parent context
                            $parentContextScore = 0;
                            if (!empty($parentContextPatterns)) {
                                // Look backwards from current line to find parent elements
                                for ($parentLine = $i - 1; $parentLine >= max(0, $i - 50); $parentLine--) {
                                    $parentLineContent = $lines[$parentLine];

                                    // Check each parent level (closest to farthest)
                                    foreach ($parentContextPatterns as $parentPattern) {
                                        foreach ($parentPattern['classes'] as $parentClass) {
                                            if (preg_match('/class=["\'](?:[^"\']* )?' . preg_quote($parentClass, '/') . '(?:\s|["\']|\{)/i', $parentLineContent)) {
                                                // Found a parent class - score based on how close the parent is
                                                // Closer parents get higher score (level 0 = closest)
                                                $parentContextScore = max($parentContextScore, 10 - $parentPattern['level']);
                                                break 2; // Found parent, stop searching this level
                                            }
                                        }
                                    }
                                }
                            }

                            // Store match with parent context score for later comparison
                            $currentMatch = [
                                'found' => true,
                                'line' => $i + 1,
                                'content' => trim($line),
                                'matchedPattern' => implode(' ', $classesToSearch),
                                'parentContextScore' => $parentContextScore
                            ];

                            // If no best match yet, or this match has better parent context, use it
                            if (!$bestMatch || $parentContextScore > ($bestMatch['parentContextScore'] ?? 0)) {
                                $bestMatch = $currentMatch;
                                $bestPriority = 3;
                            }
                            break; // Found class match for this line, move to next line
                        }
                    }
                }

                // PRIORITY 4: Partial class prefix with Twig
                if ($bestPriority > 4) {
                    foreach ($prefixPatterns as $prefixData) {
                        if (preg_match('/' . $prefixData['pattern'] . '/i', $line)) {
                            $bestMatch = [
                                'found' => true,
                                'line' => $i + 1,
                                'content' => trim($line),
                                'matchedPattern' => $prefixData['prefix'] . '{{ ... }}'
                            ];
                            $bestPriority = 4;
                            break;
                        }
                    }
                }
            }

            // Return best match found, or try tag search
            if ($bestMatch) {
                return new JsonResponse($bestMatch);
            }

            // PRIORITY 5: Tag-based search as final fallback (for elements like <img> with minimal attributes)
            if ($searchTag) {
                for ($i = $startSearch; $i < count($lines); $i++) {
                    $line = $lines[$i];
                    // Look for opening tag: <img or <div or <span etc.
                    if (preg_match('/<' . preg_quote($searchTag, '/') . '(?:\s|>)/i', $line)) {
                        return new JsonResponse([
                            'found' => true,
                            'line' => $i + 1,
                            'content' => trim($line),
                            'matchedPattern' => '<' . $searchTag . '>'
                        ]);
                    }
                }
            }

            // If not found, return block start line
            return new JsonResponse([
                'found' => false,
                'line' => $blockStartLine,
                'matchedPattern' => null,
                'message' => 'No match found, using block start line'
            ]);

        } catch (\Exception $e) {
            return new JsonResponse(['error' => $e->getMessage()], 500);
        }
    }
}
