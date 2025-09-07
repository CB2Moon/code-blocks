import * as codeBlocks from "./extension";
import * as configuration from "./configuration";
import * as vscode from "vscode";
import type { MoveSelectionDirection } from "./FileTree";
import { positionToPoint } from "./FileTree";
import type { UpdateSelectionDirection } from "./Selection";
import { getLogger } from "./outputChannel";
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
        activeEditor.revealRange(
            activeEditor.selection,
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
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
        activeEditor.revealRange(
            activeEditor.selection,
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
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
        activeEditor.revealRange(
            activeEditor.selection,
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
    }
}

function selectInside(): void {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;
    if (fileTree === undefined || activeEditor === undefined) {
        return;
    }

    const selection = activeEditor.selection;
    const node = fileTree.tree.rootNode.namedDescendantForPosition(positionToPoint(selection.start));

    const innerPair = findContainingPair(node);
    if (!innerPair) {
        return;
    }

    const innerPairFullRange = new vscode.Range(innerPair.open.range.start, innerPair.close.range.end);

    if (selection.isEqual(innerPair.contentRange)) {
        // If content is selected, select the whole pair
        activeEditor.selection = new vscode.Selection(innerPairFullRange.start, innerPairFullRange.end);
    } else if (selection.isEqual(innerPairFullRange)) {
        // If whole pair is selected, find the next parent pair and select its content
        const outerPair = findContainingPair(innerPair.node.parent);
        if (outerPair) {
            activeEditor.selection = new vscode.Selection(outerPair.contentRange.start, outerPair.contentRange.end);
        }
    } else {
        // Otherwise, select the content of the innermost pair
        activeEditor.selection = new vscode.Selection(innerPair.contentRange.start, innerPair.contentRange.end);
    }

    activeEditor.revealRange(activeEditor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function selectSurroundingPair(): void {
    const fileTree = codeBlocks.activeFileTree.get();
    const activeEditor = vscode.window.activeTextEditor;
    if (fileTree === undefined || activeEditor === undefined) {
        return;
    }

    const node = fileTree.tree.rootNode.namedDescendantForPosition(positionToPoint(activeEditor.selection.start));
    const pair = findContainingPair(node);

    if (pair) {
        activeEditor.selections = [
            new vscode.Selection(pair.open.range.start, pair.open.range.end),
            new vscode.Selection(pair.close.range.start, pair.close.range.end),
        ];
        activeEditor.revealRange(pair.open.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
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
            updateTargetHighlights(event.textEditor, event.selections[0])
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
                updateTargetHighlights(
                    vscode.window.activeTextEditor,
                    vscode.window.activeTextEditor.selection
                );
            }
        }),
    ];

    const cmd = (
        command: string,
        callback: (...args: unknown[]) => unknown,
        thisArg?: unknown
    ): vscode.Disposable => vscode.commands.registerCommand(command, callback, thisArg);
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
