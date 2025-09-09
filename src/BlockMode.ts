import * as vscode from "vscode";
import * as configuration from "./configuration";
import * as codeBlocks from "./extension";
import type { MoveSelectionDirection } from "./FileTree";
import { positionToPoint } from "./FileTree";
import { getLogger } from "./outputChannel";
import type { UpdateSelectionDirection } from "./Selection";
import { state } from "./state";
import { findContainingPair } from "./utilities/selectionUtils";

export const blockModeActive = state(false);
const colorConfig = state(configuration.getColorConfig());

const decorations = {
    sibling: vscode.window.createTextEditorDecorationType({
        backgroundColor: colorConfig.get().siblingColor,
    }),
    parent: vscode.window.createTextEditorDecorationType({
        backgroundColor: colorConfig.get().parentColor,
    }),
};

function resetDecorations(): void {
    // even if block mode isn't active, disposing these can't hurt
    decorations.sibling.dispose();
    decorations.parent.dispose();

    if (!blockModeActive.get() || !colorConfig.get().enabled) {
        return;
    }

    decorations.sibling = vscode.window.createTextEditorDecorationType({
        backgroundColor: colorConfig.get().siblingColor,
    });
    decorations.parent = vscode.window.createTextEditorDecorationType({
        backgroundColor: colorConfig.get().parentColor,
    });
}

function selectBlock(): void {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor?.document === undefined || fileTree === undefined) {
        return;
    }

    const cursorIndex = activeEditor.document.offsetAt(activeEditor.selection.active);
    const selection = fileTree.selectBlock(cursorIndex);
    if (selection !== undefined) {
        activeEditor.selection = selection.toVscodeSelection();
        activeEditor.revealRange(activeEditor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
}

function updateSelection(direction: UpdateSelectionDirection): void {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor?.document === undefined || fileTree === undefined) {
        return;
    }

    const selection = fileTree.resolveVscodeSelection(activeEditor.selection);
    if (selection !== undefined) {
        selection.update(direction, fileTree.blocks);
        activeEditor.selection = selection.toVscodeSelection();
        activeEditor.revealRange(activeEditor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
}

async function moveSelection(direction: MoveSelectionDirection): Promise<void> {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;
    if (fileTree === undefined || activeEditor === undefined) {
        return;
    }

    const selection = fileTree.resolveVscodeSelection(activeEditor.selection);
    if (selection === undefined) {
        return;
    }

    const result = await fileTree.moveSelection(selection, direction);
    switch (result.status) {
        case "ok":
            activeEditor.selection = result.result;
            activeEditor.revealRange(result.result, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            break;

        case "err":
            // TODO: add this as a text box above the cursor (can vscode do that?)
            getLogger().log(result.result);

            break;
    }
}

function navigate(direction: "up" | "down" | "left" | "right"): void {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor?.document === undefined || fileTree === undefined) {
        return;
    }

    const selection = fileTree.resolveVscodeSelection(activeEditor.selection);
    const blocks = fileTree.blocks;
    const parent = selection?.getParent(blocks);
    const previous = selection?.getPrevious(blocks);
    const next = selection?.getNext(blocks);

    let newPosition;
    switch (direction) {
        case "up":
            if (parent) {
                newPosition = parent.toVscodeSelection().start;
            }
            break;
        case "down":
            if (parent) {
                newPosition = parent.toVscodeSelection().end;
            }
            break;
        case "left":
            if (previous) {
                newPosition = previous.toVscodeSelection().start;
            }
            break;
        case "right":
            if (next) {
                newPosition = next.toVscodeSelection().start;
            }
            break;
    }

    if (newPosition) {
        activeEditor.selection = new vscode.Selection(newPosition, newPosition);
        activeEditor.revealRange(activeEditor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
}

function selectInside(): void {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;
    if (fileTree === undefined || activeEditor === undefined) {
        return;
    }

    const selections = activeEditor.selections.length ? activeEditor.selections : [activeEditor.selection];
    const newSelections: vscode.Selection[] = [];

    for (const selection of selections) {
        const node = fileTree.tree.rootNode.namedDescendantForPosition(positionToPoint(selection.start));

        let pair = findContainingPair(node);
        if (!pair) {
            continue;
        }

        // This loop will find the smallest pair that is not fully contained in the selection.
        // In other words, it syncs up `pair` with the current `selection` level.
        while (true) {
            const pairFullRange = new vscode.Range(pair.open.range.start, pair.close.range.end);
            if (selection.contains(pairFullRange) && !selection.isEqual(pairFullRange)) {
                const outerPair = findContainingPair(pair.node.parent);
                if (outerPair) {
                    pair = outerPair;
                } else {
                    break; // No bigger pair, stay with this one
                }
            } else {
                break; // Found the pair to work with
            }
        }

        const pairFullRange = new vscode.Range(pair.open.range.start, pair.close.range.end);

        if (selection.isEqual(pair.contentRange)) {
            newSelections.push(new vscode.Selection(pairFullRange.start, pairFullRange.end));
        } else if (selection.isEqual(pairFullRange)) {
            const outerPair = findContainingPair(pair.node.parent);
            if (outerPair) {
                if (selection.isEqual(outerPair.contentRange)) {
                    const outerPairFullRange = new vscode.Range(outerPair.open.range.start, outerPair.close.range.end);
                    newSelections.push(new vscode.Selection(outerPairFullRange.start, outerPairFullRange.end));
                } else {
                    newSelections.push(new vscode.Selection(outerPair.contentRange.start, outerPair.contentRange.end));
                }
            } else {
                // No outer pair, keep current full range
                newSelections.push(new vscode.Selection(pairFullRange.start, pairFullRange.end));
            }
        } else {
            newSelections.push(new vscode.Selection(pair.contentRange.start, pair.contentRange.end));
        }
    }

    // Merge overlapping or touching selections
    if (newSelections.length > 1) {
        const ranges = newSelections.map(s => new vscode.Range(s.start, s.end));
        ranges.sort((a, b) => {
            if (a.start.isBefore(b.start)) return -1;
            if (a.start.isAfter(b.start)) return 1;
            if (a.end.isBefore(b.end)) return -1;
            if (a.end.isAfter(b.end)) return 1;
            return 0;
        });

        const merged: vscode.Range[] = [];
        for (const r of ranges) {
            const last = merged[merged.length - 1];
            if (!last) {
                merged.push(r);
            } else {
                // overlap or touch => merge
                if (!r.start.isAfter(last.end)) {
                    const end = r.end.isAfter(last.end) ? r.end : last.end;
                    merged[merged.length - 1] = new vscode.Range(last.start, end);
                } else {
                    merged.push(r);
                }
            }
        }

        activeEditor.selections = merged.map(r => new vscode.Selection(r.start, r.end));
    } else if (newSelections.length === 1) {
        activeEditor.selection = newSelections[0];
    }

    const reveal = (activeEditor.selections[0] ?? activeEditor.selection);
    activeEditor.revealRange(reveal, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function selectSurroundingPair(): void {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;
    if (fileTree === undefined || activeEditor === undefined) {
        return;
    }

    const selections = activeEditor.selections.length ? activeEditor.selections : [activeEditor.selection];
    const pairSelections: vscode.Selection[] = [];

    for (const sel of selections) {
        const node = fileTree.tree.rootNode.namedDescendantForPosition(positionToPoint(sel.start));
        const pair = findContainingPair(node);
        if (pair) {
            pairSelections.push(new vscode.Selection(pair.open.range.start, pair.open.range.end));
            pairSelections.push(new vscode.Selection(pair.close.range.start, pair.close.range.end));
        }
    }

    if (pairSelections.length === 0) {
        return;
    }

    // De-duplicate identical selections, keep separate delimiters
    pairSelections.sort((a, b) => {
        if (a.start.isBefore(b.start)) return -1;
        if (a.start.isAfter(b.start)) return 1;
        if (a.end.isBefore(b.end)) return -1;
        if (a.end.isAfter(b.end)) return 1;
        return 0;
    });
    const seen = new Set<string>();
    const deduped: vscode.Selection[] = [];
    for (const s of pairSelections) {
        const key = `${s.start.line}:${s.start.character}-${s.end.line}:${s.end.character}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(s);
        }
    }

    activeEditor.selections = deduped;
    activeEditor.revealRange(deduped[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function updateTargetHighlights(editor: vscode.TextEditor, vscodeSelection: vscode.Selection): void {
    if (!blockModeActive.get() || !colorConfig.get().enabled) {
        return;
    }

    const fileTree = codeBlocks.activeFileTree.get();
    if (editor.document.uri !== fileTree?.document.uri) {
        return;
    }

    const selection = fileTree.resolveVscodeSelection(vscodeSelection);
    if (selection === undefined) {
        editor.setDecorations(decorations.sibling, []);
        editor.setDecorations(decorations.parent, []);
        return;
    }

    const blocks = fileTree.blocks;
    let parent = selection.getParent(blocks);
    if (parent?.firstNode().parent === null) {
        // parent is the entire file, not a relevant selection ever
        parent = undefined;
    }
    const previous = selection.getPrevious(blocks);
    const next = selection.getNext(blocks);

    const targets = [];
    const forceTargets = [];

    if (previous) {
        targets.push(previous.toVscodeSelection());
    }

    if (next) {
        targets.push(next.toVscodeSelection());
    }

    if ((!next || !previous) && parent) {
        forceTargets.push(parent.toVscodeSelection());
    }

    editor.setDecorations(decorations.sibling, targets);
    editor.setDecorations(decorations.parent, forceTargets);
}

export function toggleBlockMode(): void {
    blockModeActive.set(!blockModeActive.get());
}

export function activate(): vscode.Disposable[] {
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusBar.text = "-- BLOCK MODE --";

    const uiDisposables = [statusBar];

    const eventListeners = [
        vscode.window.onDidChangeActiveTextEditor(resetDecorations),
        vscode.window.onDidChangeTextEditorSelection((event) =>
            updateTargetHighlights(event.textEditor, event.selections[0]),
        ),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("colors")) {
                colorConfig.set(configuration.getColorConfig());
            }
        }),
        colorConfig.onDidChange((_) => {
            resetDecorations();
            const editor = vscode.window.activeTextEditor;
            if (editor !== undefined) {
                updateTargetHighlights(editor, editor.selection);
            }
        }),
        codeBlocks.active.onDidChange((newActive) => {
            if (!newActive && blockModeActive.get()) {
                blockModeActive.set(true);
            }
        }),
        codeBlocks.activeFileTree.onDidChange((_) => {
            const editor = vscode.window.activeTextEditor;
            if (editor !== undefined) {
                updateTargetHighlights(editor, editor.selection);
            }
        }),
        blockModeActive.onDidChange(async (active) => {
            await vscode.commands.executeCommand("setContext", "codeBlocks.blockMode", active);
        }),
        blockModeActive.onDidChange((active) => {
            active ? statusBar.show() : statusBar.hide();
            resetDecorations();

            if (vscode.window.activeTextEditor !== undefined) {
                updateTargetHighlights(vscode.window.activeTextEditor, vscode.window.activeTextEditor.selection);
            }
        }),
    ];

    const cmd = (command: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown): vscode.Disposable =>
        vscode.commands.registerCommand(command, callback, thisArg);
    const commands = [
        cmd("codeBlocks.toggleBlockMode", () => toggleBlockMode()),
        cmd("codeBlocks.moveUp", async () => await moveSelection("swap-previous")),
        cmd("codeBlocks.moveDown", async () => await moveSelection("swap-next")),
        cmd("codeBlocks.selectBlock", selectBlock),
        cmd("codeBlocks.selectParent", () => updateSelection("parent")),
        cmd("codeBlocks.selectChild", () => updateSelection("child")),
        cmd("codeBlocks.selectNext", () => updateSelection("add-next")),
        cmd("codeBlocks.selectPrevious", () => updateSelection("add-previous")),
        cmd("codeBlocks.navigateUpForce", () => navigate("up")),
        cmd("codeBlocks.navigateDownForce", () => navigate("down")),
        cmd("codeBlocks.navigateUp", () => navigate("left")),
        cmd("codeBlocks.navigateDown", () => navigate("right")),
        cmd("codeBlocks.selectInside", selectInside),
        cmd("codeBlocks.selectSurroundingPair", selectSurroundingPair),
        cmd("codeBlocks.toggleBlockModeColors", () => {
            const newConfig = colorConfig.get();
            newConfig.enabled = !newConfig.enabled;
            return colorConfig.set(newConfig);
        }),
    ];

    return [...uiDisposables, ...eventListeners, ...commands];
}
