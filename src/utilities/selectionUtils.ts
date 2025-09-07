import * as vscode from "vscode";
import type { SyntaxNode } from "tree-sitter";

export type Pair = {
    open: { text: string; range: vscode.Range };
    close: { text: string; range: vscode.Range };
    contentRange: vscode.Range;
    node: SyntaxNode;
};

function pointToPosition(point: { row: number; column: number }): vscode.Position {
    return new vscode.Position(point.row, point.column);
}

function nodeToRange(node: SyntaxNode): vscode.Range {
    return new vscode.Range(pointToPosition(node.startPosition), pointToPosition(node.endPosition));
}

function getPairFromDelimiters(
    node: SyntaxNode,
    openDelimiter: SyntaxNode | null | undefined,
    closeDelimiter: SyntaxNode | null | undefined
): Pair | undefined {
    if (!openDelimiter || !closeDelimiter) {
        return undefined;
    }

    const openRange = nodeToRange(openDelimiter);
    const closeRange = nodeToRange(closeDelimiter);
    const contentRange = new vscode.Range(openRange.end, closeRange.start);

    return {
        open: { text: openDelimiter.text, range: openRange },
        close: { text: closeDelimiter.text, range: closeRange },
        contentRange,
        node,
    };
}

/**
 * Finds the closest structural pair that contains the given starting node.
 *
 * How it works:
 * 1. It starts at the given `startNode` (usually the node under the cursor).
 * 2. It travels *up* the syntax tree, checking each parent node.
 * 3. For each parent node, it checks if its `type` matches a known "pair" type (e.g., "object", "array", "arguments").
 * 4. For most standard pairs, the opening and closing delimiters are simply the first and last children of the node (e.g., `{` and `}` for an "object").
 * 5. For special cases like "jsx_element", it performs a more specific check to find the opening and closing tags.
 * 6. Once a valid pair is found, it returns a `Pair` object with the ranges for the delimiters and the content. If it reaches the top of the tree without finding a pair, it returns `undefined`.
 *
 * @param startNode The node to start searching from. The search goes upwards from here.
 * @returns A `Pair` object if a containing pair is found, otherwise `undefined`.
 */
export function findContainingPair(startNode: SyntaxNode | null | undefined): Pair | undefined {
    let node = startNode;
    while (node) {
        const open = node.firstChild;
        const close = node.lastChild;

        switch (node.type) {
            // These node types are standard pairs where the first and last children are the delimiters.
            case "parenthesized_expression":
            case "object":
            case "object_pattern":
            case "array":
            case "string":
            case "named_imports":
            case "jsx_expression":
            case "arguments":
            case "formal_parameters":
            case "statement_block":
                return getPairFromDelimiters(node, open, close);

            // JSX elements are a special case. The opening and closing tags are children,
            // but we need to verify their types specifically.
            case "jsx_element":
                if (open?.type === "jsx_opening_element" && close?.type === "jsx_closing_element") {
                    return getPairFromDelimiters(node, open, close);
                }
                break;
        }

        node = node.parent;
    }

    return undefined;
}