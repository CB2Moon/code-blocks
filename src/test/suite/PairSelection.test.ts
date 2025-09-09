import { expect } from "chai";
import * as vscode from "vscode";
import { openDocument } from "./testUtils";

suite("Pair Selection", function () {
    this.timeout(process.env.TEST_TIMEOUT ?? "2s");

    suite("selectInside", function () {
        this.beforeAll(() => {
            return void vscode.window.showInformationMessage("Start PairSelection.selectInside tests");
        });

        test("it recursively selects inside out in tsx", async function () {
            const content = `const x = { foo: (bar) };`;
            const { activeEditor } = await openDocument(content, "typescriptreact");

            // 1. Start with cursor on "bar"
            activeEditor.selection = new vscode.Selection(0, 20, 0, 20);

            // 2. Select `bar`
            await vscode.commands.executeCommand("codeBlocks.selectInside");
            let selection = activeEditor.selection;
            expect(activeEditor.document.getText(selection)).to.equal("bar");

            // 3. Select `(bar)`
            await vscode.commands.executeCommand("codeBlocks.selectInside");
            selection = activeEditor.selection;
            expect(activeEditor.document.getText(selection)).to.equal("(bar)");

            // 4. Select `foo: (bar)` -> This is not a standard pair, so expansion should stop or go to the next structural pair.
            // The current logic will expand to the content of the object, which is correct.
            await vscode.commands.executeCommand("codeBlocks.selectInside");
            selection = activeEditor.selection;
            expect(activeEditor.document.getText(selection)).to.equal(" foo: (bar) ");

            // 5. Select `{ foo: (bar) }`
            await vscode.commands.executeCommand("codeBlocks.selectInside");
            selection = activeEditor.selection;
            expect(activeEditor.document.getText(selection)).to.equal("{ foo: (bar) }");
        });

        test("it selects inside function call parentheses", async function () {
            const content = `useQuery({ key: ["value"] });`;
            const { activeEditor } = await openDocument(content, "typescript");

            // 1. Start with cursor on "key"
            activeEditor.selection = new vscode.Selection(0, 13, 0, 13);

            // 2. Select content of object
            await vscode.commands.executeCommand("codeBlocks.selectInside");
            let selection = activeEditor.selection;
            expect(activeEditor.document.getText(selection).trim()).to.equal(`key: ["value"]`);

            // 3. Select object including braces
            await vscode.commands.executeCommand("codeBlocks.selectInside");
            selection = activeEditor.selection;
            expect(activeEditor.document.getText(selection)).to.equal(`{ key: ["value"] }`);

            // 4. Select arguments including parentheses
            await vscode.commands.executeCommand("codeBlocks.selectInside");
            selection = activeEditor.selection;
            expect(activeEditor.document.getText(selection)).to.equal(`({ key: ["value"] })`);
        });
    });

    suite("selectSurroundingPair", function () {
        this.beforeAll(() => {
            return void vscode.window.showInformationMessage("Start PairSelection.selectSurroundingPair tests");
        });

        test("it selects surrounding braces with multi-cursor", async function () {
            const content = `const x = { foo: "bar" };`;
            const { activeEditor } = await openDocument(content, "typescript");

            // 1. Start with cursor on "foo"
            activeEditor.selection = new vscode.Selection(0, 13, 0, 13);

            // 2. Select surrounding {}
            await vscode.commands.executeCommand("codeBlocks.selectSurroundingPair");
            const selections = activeEditor.selections;
            expect(selections.length).to.equal(2);
            expect(activeEditor.document.getText(selections[0])).to.equal("{");
            expect(activeEditor.document.getText(selections[1])).to.equal("}");
        });

        test("it selects surrounding jsx tags with multi-cursor", async function () {
            const content = `<div><p>hello</p></div>`;
            const { activeEditor } = await openDocument(content, "typescriptreact");

            // 1. Start with cursor on "hello"
            activeEditor.selection = new vscode.Selection(0, 10, 0, 10);

            // 2. Select surrounding <p> tags
            await vscode.commands.executeCommand("codeBlocks.selectSurroundingPair");
            const selections = activeEditor.selections;
            expect(selections.length).to.equal(2);
            expect(activeEditor.document.getText(selections[0])).to.equal("<p>");
            expect(activeEditor.document.getText(selections[1])).to.equal("</p>");
        });
    });
});
