'use strict';
import * as vscode from 'vscode';
import { Spectral } from '@stoplight/spectral-core';
import { truthy } from '@stoplight/spectral-functions'; // this has to be installed as well
import { DiagnosticSeverity } from '@stoplight/types';
import { readFile } from '@stoplight/spectral-runtime';
import { parseYaml, parseJson } from '@stoplight/spectral-parsers';

const spectral = new Spectral();

export async function activate(context: vscode.ExtensionContext) {
    const collection = vscode.languages.createDiagnosticCollection('spectral');
    if (vscode.window.activeTextEditor) {
        updateDiagnostics(vscode.window.activeTextEditor.document, collection);
    }
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                updateDiagnostics(editor.document, collection);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('yaml', new MyCodeActionProvider(), {
            providedCodeActionKinds: MyCodeActionProvider.providedCodeActionKinds,
        })
    );
}

async function updateDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): Promise<void> {
    const rule = await loadRules('d:/dev/apitools/linter-config/openapi/rules/itx-spectral.yaml');
    try {
        spectral.setRuleset({ ...rule });
    } catch (e) {
        // Error: Error at #/: must NOT have additional properties
        // Error at #/rules/contact-email: must NOT have additional properties
        //     at assertValidRuleset (d:\dev\public-repos\vscode-extension-samples\diagnostic-related-information-sample\node_modules\@stoplight\spectral-core\src\ruleset\validation.ts:117:11)
        //     at new Ruleset (d:\dev\public-repos\vscode-extension-samples\diagnostic-related-information-sample\node_modules\@stoplight\spectral-core\src\ruleset\ruleset.ts:59:25)
        //     at Spectral.setRuleset (d:\dev\public-repos\vscode-extension-samples\diagnostic-related-information-sample\node_modules\@stoplight\spectral-core\src\spectral.ts:101:59)
        //     at updateDiagnostics (d:\dev\public-repos\vscode-extension-samples\diagnostic-related-information-sample\src\extension.ts:35:18)
        console.error(e);
        spectral.setRuleset({
            // a ruleset has to be provided
            rules: {
                'no-empty-description': {
                    given: '$..description',
                    message: 'Description must not be empty',
                    then: {
                        function: truthy,
                    },
                    // codeAction: { title: 'Add description', command: 'addDescription' },
                },
            },
        });
    }

    if (document.languageId === 'json' || document.languageId === 'yml' || document.languageId === 'yaml') {
        collection.clear();

        spectral
            .run(document.getText())
            .then(results => {
                const diagnostics = results.map(result => {
                    return {
                        code: result.code,
                        message: result.message,
                        range: new vscode.Range(
                            new vscode.Position(result.range.start.line, result.range.start.character),
                            new vscode.Position(result.range.end.line, result.range.end.character)
                        ),
                        severity: convertSeverity(result.severity),
                        source: 'spectral',
                    };
                });
                collection.set(document.uri, diagnostics);
            })
            .catch(err => {
                console.log('Error running spectral on document', err);
            });
        return;
    }
}

/**
 * Converts a Spectral rule violation severity into a VS Code diagnostic severity.
 * @param {DiagnosticSeverity} severity - The Spectral diagnostic severity to convert.
 * @return {DiagnosticSeverity} The converted severity for a VS Code diagnostic.
 */
function convertSeverity(severity: DiagnosticSeverity): vscode.DiagnosticSeverity {
    return (<any>vscode.DiagnosticSeverity)[DiagnosticSeverity[severity]];
}

async function loadRules(uri: string): Promise<any> {
    const contents = await readFile(uri, { timeout: 1000, encoding: 'utf8' });
    const parse = uri.endsWith('.yaml') || uri.endsWith('yml') ? parseYaml : parseJson;
    return parse(contents);
}

export class MyCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] | undefined {
        console.log('provideCodeActions', range, context.diagnostics?.map(d => d.code).join(', '));
        const codeActions = context.diagnostics
            .map(diagnostic => {
                if (diagnostic.code === 'no-empty-description') {
                    return this.createFix(document, range);
                }
                return null;
            })
            .filter(action => action !== null);
        return codeActions as vscode.CodeAction[];
    }

    private createFix(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction {
        const fix = new vscode.CodeAction('Add description', vscode.CodeActionKind.QuickFix);
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, new vscode.Range(range.start, range.start.translate(0, 2)), 'tratra');
        return fix;
    }
}
