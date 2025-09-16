import * as BlockMode from "./BlockMode";
import * as vscode from "vscode";
import { CodeBlocksEditorProvider } from "./editor/CodeBlocksEditorProvider";
import { FileTree } from "./FileTree";
import { TreeViewer } from "./TreeViewer";
import { getLanguage } from "./Installer";
import { getLogger } from "./outputChannel";
import { join } from "path";
import * as fs from "fs";
import { cp } from "fs/promises";
import { state } from "./state";

export const parserFinishedInit = Promise.resolve();

async function reopenWithCodeBocksEditor(): Promise<void> {
    const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input as {
        [key: string]: unknown;
        uri: vscode.Uri | undefined;
    };

    if (activeTabInput.uri !== undefined) {
        await vscode.commands.executeCommand("vscode.openWith", activeTabInput.uri, "codeBlocks.editor");
    }
}

async function openCodeBlocksEditorToTheSide(): Promise<void> {
    const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input as {
        [key: string]: unknown;
        uri: vscode.Uri | undefined;
    };

    if (activeTabInput.uri !== undefined) {
        await vscode.commands.executeCommand("vscode.openWith", activeTabInput.uri, "codeBlocks.editor");
        await vscode.commands.executeCommand("workbench.action.moveEditorToNextGroup");
    }
}

async function getEditorFileTree(
    parsersDir: string,
    editor: vscode.TextEditor | undefined
): Promise<FileTree | undefined> {
    const logger = getLogger();

    if (editor?.document === undefined) {
        logger.log("No active document");
        return undefined;
    }

    const activeDocument = editor.document;
    const language = await getLanguage(parsersDir, activeDocument.languageId);
    if (language.status === "err" || language.result === undefined) {
        if (language.status === "err") {
            void vscode.window.showErrorMessage(`Failed to get language: ${language.result}`);
        } else {
            logger.log(`No language found for ${activeDocument.languageId}`);
        }

        return undefined;
    }

    const tree = await FileTree.new(language.result, activeDocument);
    if (tree.status === "ok") {
        return tree.result;
    }

    void vscode.window.showErrorMessage(
        `Failed to load parser for ${activeDocument.languageId}: ${JSON.stringify(tree.result)}`
    );

    return undefined;
}

export const active = state(true);
export const activeFileTree = state<FileTree | undefined>(undefined);

export function toggleActive(): void {
    active.set(!active.get());
}

export { BlockMode };

// auto parsers migration from original extension (TODO: Not tested)
const ORIGINAL_EXTENSION_ID = "selfint.code-blocks";
const MIGRATION_STATE_KEY = "parsersMigrationChoice"; // 'migrated' | 'never' | 'later'

async function shouldOfferMigration(
    context: vscode.ExtensionContext,
    currentParsersDir: string
): Promise<"migrate" | "never" | "skip" | "later"> {
    try {
        // existing decision
        const decision = context.globalState.get<string>(MIGRATION_STATE_KEY);
        if (decision === "migrated" || decision === "never") {
            return "skip"; // Already handled
        }

        // current parsers directory contents
        let currentContents: string[] = [];
        if (fs.existsSync(currentParsersDir)) {
            currentContents = fs.readdirSync(currentParsersDir).filter((f) => !f.startsWith("."));
        }
        if (currentContents.length > 0) {
            // Nothing to do
            return "skip";
        }

        const originalExt = vscode.extensions.getExtension(ORIGINAL_EXTENSION_ID);
        if (!originalExt) {
            return "skip"; // Original not installed
        }
        const originalParsersDir = join(originalExt.extensionPath, "parsers");
        if (!fs.existsSync(originalParsersDir)) {
            return "skip";
        }
        const originalContents = fs
            .readdirSync(originalParsersDir)
            .filter((f) => !f.startsWith("."));
        if (originalContents.length === 0) {
            return "skip";
        }

        const selection = await vscode.window.showInformationMessage(
            "Existing Code Blocks parsers detected from original extension. Migrate them to avoid re-downloading?",
            "Migrate",
            "Never",
            "Decide Later"
        );

        if (selection === "Migrate") return "migrate";
        if (selection === "Never") return "never";
        if (selection === "Decide Later") return "later";
        return "skip"; // dismissed
    } catch (e) {
        getLogger().log(`Migration check failed > ${JSON.stringify(e)}`);
        return "skip";
    }
}

// TODO: Not tested
async function performMigration(
    context: vscode.ExtensionContext,
    currentParsersDir: string
): Promise<void> {
    const originalExt = vscode.extensions.getExtension(ORIGINAL_EXTENSION_ID);
    if (!originalExt) return;
    const originalParsersDir = join(originalExt.extensionPath, "parsers");
    if (!fs.existsSync(originalParsersDir)) return;
    await fs.promises.mkdir(currentParsersDir, { recursive: true });
    const logger = getLogger();
    logger.log(`Migrating parsers from ${originalParsersDir} -> ${currentParsersDir}`);
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Migrating Code Blocks parsers...",
                cancellable: false,
            },
            async (progress) => {
                const entries = fs.readdirSync(originalParsersDir).filter((f) => !f.startsWith("."));
                let done = 0;
                for (const entry of entries) {
                    const src = join(originalParsersDir, entry);
                    const dest = join(currentParsersDir, entry);
                    progress.report({ message: entry, increment: (1 / entries.length) * 100 });
                    // Use fs.cp (Node 16+) via promise wrapper (imported as cp above) if available; fallback manual
                    await cp(src, dest, { recursive: true, force: false });
                    done++;
                }
                progress.report({ message: `Migrated ${done} parser(s)` });
            }
        );
        await context.globalState.update(MIGRATION_STATE_KEY, "migrated");
        logger.log("Parsers migration completed successfully");
    } catch (e) {
        logger.log(`Failed migration > ${JSON.stringify(e)}`);
        void vscode.window.showErrorMessage(
            `Failed to migrate existing parsers; they will be re-downloaded as needed. Error: ${e}`
        );
    }
}

export function activate(context: vscode.ExtensionContext): void {
    getLogger().log("CodeBlocks activated");

    const parsersDir = join(
        context.extensionPath,
        context.extensionMode === vscode.ExtensionMode.Test ? "test-parsers" : "parsers"
    );

    // One-time migration logic (non-blocking, TODO: not tested)
    void (async () => {
        const action = await shouldOfferMigration(context, parsersDir);
        if (action === "migrate") {
            await performMigration(context, parsersDir);
        } else if (action === "never") {
            await context.globalState.update(MIGRATION_STATE_KEY, "never");
        } else if (action === "later") {
            await context.globalState.update(MIGRATION_STATE_KEY, "later");
        }
    })();

    void getEditorFileTree(parsersDir, vscode.window.activeTextEditor).then((newActiveFileTree) =>
        activeFileTree.set(newActiveFileTree)
    );

    const uiDisposables = [
        vscode.window.registerCustomEditorProvider(
            CodeBlocksEditorProvider.viewType,
            new CodeBlocksEditorProvider(context, parsersDir)
        ),
        vscode.workspace.registerTextDocumentContentProvider(TreeViewer.scheme, TreeViewer.treeViewer),
    ];

    const eventListeners = [
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (!active.get()) {
                return;
            }

            if (editor?.document.uri.toString() === TreeViewer.uri.toString()) {
                return;
            }

            activeFileTree.set(await getEditorFileTree(parsersDir, editor));
        }),
        active.onDidChange(async (active) => {
            if (active && vscode.window.activeTextEditor !== undefined) {
                activeFileTree.set(await getEditorFileTree(parsersDir, vscode.window.activeTextEditor));
            }
        }),
        activeFileTree.onDidChange((newFileTree) => TreeViewer.viewFileTree(newFileTree)),
        BlockMode.blockModeActive.onDidChange(async (blockModeActive) => {
            if (
                blockModeActive &&
                active.get() &&
                activeFileTree.get() === undefined &&
                vscode.window.activeTextEditor !== undefined
            ) {
                activeFileTree.set(await getEditorFileTree(parsersDir, vscode.window.activeTextEditor));
            }
        }),
    ];

    const cmd = (
        command: string,
        callback: (...args: unknown[]) => unknown,
        thisArg?: unknown
    ): vscode.Disposable => vscode.commands.registerCommand(command, callback, thisArg);
    const commands = [
        cmd("codeBlocks.toggleActive", () => toggleActive()),
        cmd("codeBlocks.open", async () => await reopenWithCodeBocksEditor()),
        cmd("codeBlocks.openToTheSide", async () => await openCodeBlocksEditorToTheSide()),
        cmd("codeBlocks.openTreeViewer", async () => await TreeViewer.open()),
    ];

    const blockMode = BlockMode.activate();

    context.subscriptions.push(...uiDisposables, ...eventListeners, ...commands, ...blockMode);
}
