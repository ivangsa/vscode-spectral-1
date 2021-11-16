'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
// import { getRuleset } from '@stoplight/spectral-cli';
// import { getRuleset } from '@stoplight/spectral-cli/dist/services/linter/utils'; // FIXME: find proper way to get 'getRuleset'
import { Spectral } from '@stoplight/spectral-core';
import { oas, asyncapi } from '@stoplight/spectral-rulesets';
import { DiagnosticSeverity } from '@stoplight/types';
import { readFile } from '@stoplight/spectral-runtime';
import { parseYaml, parseJson } from '@stoplight/spectral-parsers';
import * as minimatch from 'minimatch';

const DEFAULT_RULESET = { extends: [oas, asyncapi], rules: {} };
export class Configuration {
    enable: boolean = true;
    rulesetFile: string | undefined;
    run: 'onType' | 'onSave' = 'onType';
    validateFiles: string[] = [];
    validateLanguages = ['json', 'yaml'];
    documentFilters: vscode.DocumentFilter[] = []; // calculated
    workspaceFolder: vscode.WorkspaceFolder | undefined; // calculated

    constructor(config?: Partial<Configuration> | vscode.WorkspaceConfiguration) {
        if (config) {
            Object.assign(this, config);
            this.validateLanguages.forEach(language => {
                if (this.validateFiles && this.validateFiles.length > 0) {
                    this.validateFiles.forEach(pattern => {
                        this.documentFilters.push({ pattern, language });
                    });
                } else {
                    this.documentFilters.push({ language });
                }
            });
        }
    }

    get lintOnType() {
        return this.run === 'onType';
    }
}

/**
 * Finds configuration for this document workspace or global if not in a workspace.
 */
export function getConfiguration(document?: vscode.TextDocument): Configuration {
    let workspaceFolder = undefined;
    if (document && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri) || vscode.workspace.workspaceFolders?.[0];
    }
    const config = new Configuration(vscode.workspace.getConfiguration('spectral', workspaceFolder?.uri));
    config.workspaceFolder = workspaceFolder;
    return config;
}

export async function activate(context: vscode.ExtensionContext) {
    let config = getConfiguration();
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('spectral');

    console.log('Spectral VSCode: vscode.workspace.textDocuments', vscode.workspace.textDocuments);
    vscode.workspace.textDocuments?.forEach(document => {
        console.log('Spectral VSCode: textDocuments?.forEach', document.fileName);
        updateSpectralDiagnostics(document, diagnosticCollection);
    });

    const onOpenDocListener = vscode.workspace.onDidOpenTextDocument(async document => {
        // console.log('Spectral VSCode: onDidOpenTextDocument', document.fileName, document.uri.fsPath);
        updateSpectralDiagnostics(document, diagnosticCollection);
    });

    const onCloseDocListener = vscode.workspace.onDidCloseTextDocument(editor => {
        // console.log('Spectral VSCode: onDidCloseTextDocument', editor.fileName);
        diagnosticCollection.delete(editor.uri);
    });

    const onTypeListener = vscode.workspace.onDidChangeTextDocument(event => {
        // console.log('Spectral VSCode: onDidChangeTextDocument', event.document.fileName);
        config.lintOnType && updateSpectralDiagnostics(event.document, diagnosticCollection);
    });

    const onSaveListener = vscode.workspace.onDidSaveTextDocument(document => {
        // console.log('Spectral VSCode: onDidSaveTextDocument', document.fileName);
        updateSpectralDiagnostics(document, diagnosticCollection);
    });

    configureCodeActionsProvider(context.subscriptions, config);

    vscode.workspace.onDidChangeConfiguration(async e => {
        config = getConfiguration();
        if (e.affectsConfiguration('spectral.enable')) {
            if (config.enable === false) {
                diagnosticCollection.clear();
            }
        }
        if (e.affectsConfiguration('spectral.rulesetFile')) {
            diagnosticCollection.forEach(uri => {
                // TODO debug this loop
                const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
                document && updateSpectralDiagnostics(document, diagnosticCollection);
            });
        }
        if (e.affectsConfiguration('spectral.validateFiles') || e.affectsConfiguration('spectral.validateLanguages')) {
            configureCodeActionsProvider(context.subscriptions, config);
        }
    });

    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(onOpenDocListener);
    context.subscriptions.push(onCloseDocListener);
    context.subscriptions.push(onTypeListener);
    context.subscriptions.push(onSaveListener);
}

function isLintEnabled(config: Configuration, document: vscode.TextDocument): boolean {
    // console.log('Spectral VSCode: isLintEnabled', config);
    return (
        config.enable &&
        config.documentFilters.some(filter => {
            if (filter.pattern) {
                return filter.language === document.languageId && minimatch(document.fileName, filter.pattern.toString(), { matchBase: true });
            }
            return filter.language === document.languageId;
        })
    );
}

async function updateSpectralDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): Promise<void> {
    const config = getConfiguration(document);
    if (!isLintEnabled(config, document)) {
        return;
    }

    collection.delete(document.uri);

    const spectral = new Spectral();
    const ruleSet = await loadConfiguredRuleset(config, document);
    try {
        spectral.setRuleset(ruleSet.ruleSet);
    } catch (e: any) {
        console.error(`Failed configuring ruleset: ${e.message}`, ruleSet);
        vscode.window.showErrorMessage(`Failed configuring ruleset from ${ruleSet.ruleSetFile || 'default'}`);
        spectral.setRuleset(DEFAULT_RULESET);
    }

    spectral
        .run(document.getText(), { ignoreUnknownFormat: true })
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

            // console.log('Spectral VSCode: diagnostics', diagnostics);
            collection.set(document.uri, diagnostics);
        })
        .catch(err => {
            console.error('Error running spectral on document', err);
            vscode.window.showErrorMessage(`Error running spectral on document: ${err.message}`);
        });
    return;
}

async function findRulesetFile(config: Configuration, document: vscode.TextDocument): Promise<string | undefined> {
    const rulesetFile = config.rulesetFile;
    if (!rulesetFile) {
        // find .spectral.yml or .spectral.json in parent folders
        const relativeFolder = config.workspaceFolder || path.dirname(document.fileName);
        const spectralFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(relativeFolder, '.spectral.{json,yml,yaml,js,mjs}'));
        return spectralFiles.length ? spectralFiles[0]?.fsPath : undefined;
    }
    return rulesetFile;
}

async function loadConfiguredRuleset(config: Configuration, document: vscode.TextDocument): Promise<{ ruleSet: any; ruleSetFile?: string }> {
    const ruleSetFile = await findRulesetFile(config, document);
    console.log('Spectral VSCode: loading rules from ruleSetFile', ruleSetFile);
    const ruleSet = (ruleSetFile && (await readLocalOrRemoteRules(ruleSetFile))) || DEFAULT_RULESET;
    // const ruleSet = (ruleSetFile && (await getRuleset(ruleSetFile))) || DEFAULT_RULESET;
    return { ruleSet, ruleSetFile };
}

async function readLocalOrRemoteRules(uri: string): Promise<any> {
    // return getRuleset(uri);
    try {
        const contents = await readFile(uri, { timeout: 1000, encoding: 'utf8' });
        const parse = uri.endsWith('.yaml') || uri.endsWith('yml') ? parseYaml : parseJson;
        const parsed = parse(contents);
        return parsed ? JSON.parse(JSON.stringify(parsed.data)) : undefined;
    } catch (e) {
        console.error(`Failed to read ruleset from ${uri}`, e);
        vscode.window.showErrorMessage(`Failed to read ruleset file: ${uri}`);
        return null;
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

// CodeActions Provider POC placeholder

let codeActionsProvider: vscode.Disposable;
function configureCodeActionsProvider(subscriptions: vscode.Disposable[], config: Configuration) {
    codeActionsProvider?.dispose();
    codeActionsProvider = vscode.languages.registerCodeActionsProvider(config.documentFilters, new MyCodeActionProvider(), {
        providedCodeActionKinds: MyCodeActionProvider.providedCodeActionKinds,
    });
    subscriptions.push(codeActionsProvider);
}
export class MyCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] | undefined {
        // console.log('Spectral VSCode: provideCodeActions', range, context.diagnostics?.map(d => d.code).join(', '));
        const codeActions = context.diagnostics
            .map(diagnostic => {
                if (diagnostic.code === 'operation-description') {
                    return this.createFix(document, range);
                }
                return null;
            })
            .filter(action => action !== null);
        return codeActions as vscode.CodeAction[];
    }

    private createFix(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction {
        // WIP: this proof of concept only works if description is present but empty
        const fix = new vscode.CodeAction('Add description', vscode.CodeActionKind.QuickFix);
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, new vscode.Range(range.start, range.start.translate(0, 2)), 'tratra');
        return fix;
    }
}
