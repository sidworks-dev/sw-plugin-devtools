<?php declare(strict_types=1);

namespace Sidworks\DevTools\Twig;

use Twig\Environment;
use Twig\Node\BlockNode;
use Twig\Node\Expression\ConstantExpression;
use Twig\Node\Node;
use Twig\Node\PrintNode;
use Twig\NodeVisitor\NodeVisitorInterface;

class TemplateDebugNodeVisitor implements NodeVisitorInterface
{
    private int $blockCounter = 0;

    public function enterNode(Node $node, Environment $env): Node
    {
        return $node;
    }

    public function leaveNode(Node $node, Environment $env): Node
    {
        // Only process BlockNode - wrap blocks with markers
        if ($node instanceof BlockNode) {
            $blockName = $node->getAttribute('name');
            $body = $node->getNode('body');

            // Generate simple incrementing ID
            $uniqueId = ++$this->blockCounter;

            // Get template info from the block's source context
            // This tells us which file this specific block override is defined in
            $blockSourceContext = $node->getSourceContext();
            $blockTemplateName = $blockSourceContext ? $blockSourceContext->getName() : '';
            $blockTemplatePath = $blockSourceContext ? $blockSourceContext->getPath() : '';
            $lineNumber = $node->getTemplateLine();

            // Extract parent template from sw_extends or {% extends %}
            $parentTemplate = '';
            if ($blockSourceContext) {
                $templateCode = $blockSourceContext->getCode();
                if (preg_match('/\{%\s*sw_extends\s+[\'"]([^\'"]+)[\'"]\s*%\}/', $templateCode, $matches)) {
                    $parentTemplate = $matches[1];
                } elseif (preg_match('/\{%\s*extends\s+[\'"]([^\'"]+)[\'"]\s*%\}/', $templateCode, $matches)) {
                    $parentTemplate = $matches[1];
                }
            }

            // Create block start marker with unique ID
            // Format: SWDT_START[id]|blockName|templateName|templatePath|lineNumber|parentTemplate
            $blockStart = new PrintNode(
                new ConstantExpression(
                    sprintf(
                        '<!-- SWDT_START[%s]|%s|%s|%s|%d|%s -->',
                        $uniqueId,
                        htmlspecialchars($blockName),
                        htmlspecialchars($blockTemplateName),
                        htmlspecialchars($blockTemplatePath),
                        $lineNumber,
                        htmlspecialchars($parentTemplate)
                    ),
                    $node->getTemplateLine()
                ),
                $node->getTemplateLine()
            );

            // Create block end marker with matching ID
            // Format: SWDT_END[id]
            $blockEnd = new PrintNode(
                new ConstantExpression(
                    sprintf('<!-- SWDT_END[%s] -->', $uniqueId),
                    $node->getTemplateLine()
                ),
                $node->getTemplateLine()
            );

            // Wrap body with block markers
            $newBody = new Node([$blockStart, $body, $blockEnd]);
            $node->setNode('body', $newBody);
        }

        return $node;
    }

    public function getPriority(): int
    {
        return 0;
    }
}
