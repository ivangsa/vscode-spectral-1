// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as Spectral from '@stoplight/spectral';
import { parseWithPointers, getLocationForJsonPath } from '@stoplight/yaml';
import { ISpectralFullResult, isOpenApiv2, isOpenApiv3 } from '@stoplight/spectral';
import { IDiagnostic, DiagnosticSeverity } from '@stoplight/types';

const dc = vscode.languages.createDiagnosticCollection('spectral');

function ourSeverity(spectralSeverity:IDiagnostic["severity"]) {
	if (spectralSeverity === DiagnosticSeverity.Error)
		return vscode.DiagnosticSeverity.Error;
	if (spectralSeverity === DiagnosticSeverity.Warning)
		return vscode.DiagnosticSeverity.Warning;
	if (spectralSeverity === DiagnosticSeverity.Information)
		return vscode.DiagnosticSeverity.Information;
	return vscode.DiagnosticSeverity.Hint;
}

function validate(lint: boolean, resolve: boolean) {
	let editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Spectral: You must have an open editor window to lint your document.');
		return; // No open text editor
	}

	if (resolve && editor.document.isUntitled) {
		vscode.window.showWarningMessage('Spectral: Document must be saved in order to resolve correctly.');
		return; // No open text editor
	}

	let text = editor.document.getText();
	try {
		const doc = parseWithPointers(text);
		const linter = new Spectral.Spectral();
		linter.registerFormat('oas2', isOpenApiv2);
		linter.registerFormat('oas3', isOpenApiv3);
		linter.loadRuleset('spectral:oas')
		.then(function () {
			const parsedResult = {
				parsed: doc,
				getLocationForJsonPath
			};
			return linter.runWithResolved(parsedResult)
		})
		.then(function (fullResults: ISpectralFullResult) {
			const results = fullResults.results;
			dc.delete(editor!.document.uri);
			if (results && results.length) {
				const diagnostics = [];
				for (let warning of results) {
					let range = new vscode.Range(warning.range.start.line,warning.range.start.character,warning.range.end.line,warning.range.end.character);
					diagnostics.push(new vscode.Diagnostic(range, warning.message + ' ' + warning.code, ourSeverity(warning.severity)));
				}
				dc.set(editor!.document.uri, diagnostics);
			}
			else {
				let message = 'Spectral: Your document is: ' + (lint ? 'compliant!' : 'valid.');
				vscode.window.showInformationMessage(message);
			}
		})
		.catch(function (ex: Error) {
			let message = 'Spctral: Encountered error linting document :( \n';
			message += ex.message;
			vscode.window.showErrorMessage(message);
		});
	}
	catch (ex) {
		vscode.window.showErrorMessage('Spectral: Could not parse document as JSON or YAML!');
		console.warn(ex.message);
	}
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Spectral: Extension activated.');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('extension.spectral-lint', () => {
		// The code you place here will be executed every time your command is executed
		validate(true, false);
	});

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() { }
