'use strict';
import * as vscode from 'vscode';
import { Document, RuleDefinition, RulesetDefinition, Spectral } from '@stoplight/spectral-core';
import { truthy } from '@stoplight/spectral-functions'; // this has to be installed as well
import { DiagnosticSeverity } from '@stoplight/types';
import { readFile } from '@stoplight/spectral-runtime';
import { parseYaml, parseJson } from '@stoplight/spectral-parsers';
import * as minimatch from 'minimatch';

const spectral = new Spectral();

export class Configuration {
    enable: boolean = true;
    rulesetFile: string | undefined;
    run: string = 'onType';
    validateFiles: string[] = [];
    validateLanguages = ['json', 'yaml'];
    documentFilters: vscode.DocumentFilter[] = []; // calculated

    constructor(config?: Partial<Configuration> | vscode.WorkspaceConfiguration) {
        if (config) {
            Object.assign(this, config);
            // TODO improve this
            this.validateFiles.forEach(pattern => {
                this.documentFilters.push({ pattern, language: '*' });
            });
            this.validateLanguages.forEach(language => {
                this.documentFilters.push({ language });
            });
        }
    }

    get lintOnType() {
        return this.run === 'onType';
    }
}

export function getConfiguration() {
    return new Configuration(vscode.workspace.getConfiguration('spectral'));
}

let config = getConfiguration(); // global

export async function activate(context: vscode.ExtensionContext) {
    config.enable && (await loadConfiguredRuleset());

    const diagnosticCollection = vscode.languages.createDiagnosticCollection('spectral');

    console.log('vscode.workspace.textDocuments', vscode.workspace.textDocuments);
    vscode.workspace.textDocuments?.forEach(document => {
        console.log('textDocuments?.forEach', document.fileName);
        updateSpectralDiagnostics(document, diagnosticCollection);
    });

    const onOpenDocListener = vscode.workspace.onDidOpenTextDocument(async document => {
        // console.log('onDidOpenTextDocument', document.fileName, document.uri.fsPath);
        updateSpectralDiagnostics(document, diagnosticCollection);
    });

    const onCloseDocListener = vscode.workspace.onDidCloseTextDocument(editor => {
        // console.log('onDidCloseTextDocument', editor.fileName);
        diagnosticCollection.delete(editor.uri);
    });

    const onTypeListener = vscode.workspace.onDidChangeTextDocument(event => {
        // console.log('onDidChangeTextDocument', event.document.fileName);
        config.lintOnType && updateSpectralDiagnostics(event.document, diagnosticCollection);
    });

    const onSaveListener = vscode.workspace.onDidSaveTextDocument(document => {
        // console.log('onDidSaveTextDocument', document.fileName);
        updateSpectralDiagnostics(document, diagnosticCollection);
    });

    let codeActionsProvider = vscode.languages.registerCodeActionsProvider(config.documentFilters, new MyCodeActionProvider(), {
        providedCodeActionKinds: MyCodeActionProvider.providedCodeActionKinds,
    });

    vscode.workspace.onDidChangeConfiguration(async e => {
        config = getConfiguration();
        if (e.affectsConfiguration('spectral.enable')) {
            if (config.enable === false) {
                diagnosticCollection.clear();
            } else {
                await loadConfiguredRuleset();
            }
        }
        if (e.affectsConfiguration('spectral.rulesetFile')) {
            await loadConfiguredRuleset();
        }
        if (e.affectsConfiguration('spectral.validateFiles') || e.affectsConfiguration('spectral.validateLanguages')) {
            codeActionsProvider.dispose();
            codeActionsProvider = vscode.languages.registerCodeActionsProvider(config.documentFilters, new MyCodeActionProvider(), {
                providedCodeActionKinds: MyCodeActionProvider.providedCodeActionKinds,
            });
            context.subscriptions.push(codeActionsProvider);
        }
    });

    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(onOpenDocListener);
    context.subscriptions.push(onCloseDocListener);
    context.subscriptions.push(onTypeListener);
    context.subscriptions.push(onSaveListener);
    context.subscriptions.push(codeActionsProvider);
}

function isLintEnabled(document: vscode.TextDocument): boolean {
    // console.log('isLintEnabled', config);
    return (
        config.enable &&
        config.documentFilters.some(filter => {
            if (filter.language === document.languageId) {
                return true;
            }
            if (filter.pattern) {
                return minimatch(document.fileName, filter.pattern.toString(), { matchBase: true });
            }
            return false;
        })
    );
}

const defaultRuleset = {
    // extends: 'spectral:oas',
    rules: {
        'no-empty-description': {
            given: '$..description',
            message: 'Description must not be empty',
            then: {
                function: truthy,
            },
        },
    },
};
async function loadConfiguredRuleset(): Promise<any> {
    const rulesetFile = vscode.workspace.getConfiguration('spectral').get<string>('rulesetFile');
    const ruleSet = (rulesetFile && (await readLocalOrRemoteRules(rulesetFile))) || defaultRuleset;
    try {
        spectral.setRuleset(ruleSet);
    } catch (e: any) {
        console.error(`Failed configuring ruleset: ${e.message}`, ruleSet);
        vscode.window.showErrorMessage(`Failed configuring ruleset from ${rulesetFile}`);
        spectral.setRuleset(defaultRuleset);
    }
}

async function updateSpectralDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): Promise<void> {
    if (!isLintEnabled(document)) {
        return;
    }
    // console.log('updateSpectralDiagnostics', document.fileName);

    collection.delete(document.uri);
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

          console.log('diagnostics', diagnostics);
          collection.set(document.uri, diagnostics);
        })
        .catch(err => {
            console.log('Error running spectral on document', err);
            vscode.window.showErrorMessage(`Error running spectral on document: ${err.message}`);
        });
    return;
}

/**
 * Converts a Spectral rule violation severity into a VS Code diagnostic severity.
 * @param {DiagnosticSeverity} severity - The Spectral diagnostic severity to convert.
 * @return {DiagnosticSeverity} The converted severity for a VS Code diagnostic.
 */
function convertSeverity(severity: DiagnosticSeverity): vscode.DiagnosticSeverity {
    return (<any>vscode.DiagnosticSeverity)[DiagnosticSeverity[severity]];
}

async function readLocalOrRemoteRules(uri: string): Promise<any> {
    try {
        const contents = await readFile(uri, { timeout: 1000, encoding: 'utf8' });
        const parse = uri.endsWith('.yaml') || uri.endsWith('yml') ? parseYaml : parseJson;
        return parse(contents);
    } catch (e) {
        console.error(`Failed to read ruleset from ${uri}`, e);
        vscode.window.showErrorMessage(`Failed to read ruleset file: ${uri}`);
        return null;
    }
}

export class MyCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] | undefined {
        // console.log('provideCodeActions', range, context.diagnostics?.map(d => d.code).join(', '));
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
