import * as assert from 'assert';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as helper from './helper';
import * as spectralExtension from '../../extension';

const petstoreOpenapiFile = path.resolve(__dirname, 'workspace', 'petstore-openapi.yml');

suite('Extension Test Suite', () => {
    test('Should start @spectral extension', async () => {
        const started = vscode.extensions.getExtension('stoplight.spectral');
        assert.notStrictEqual(started, undefined);
        assert.strictEqual(started?.isActive, true);
    });

    test('Reset workspace configuration', async () => {
        await deleteWorspaceConfiguration();
    });

    test('Lint petstore-openapi.yml with default config', async () => {
        await deleteWorspaceConfiguration();
        const document = await helper.openFileAndWait(petstoreOpenapiFile, 2000);
        console.log('getting diagnostics');
        const actualDiagnostics = vscode.languages.getDiagnostics(document.uri);
        assert.strictEqual(actualDiagnostics.length, 7);
    });

    test('Lint disable spectral', async () => {
        await deleteWorspaceConfiguration();
        await vscode.workspace.getConfiguration('spectral').update('enable', false);
        const document = await helper.openFileAndWait(petstoreOpenapiFile, 2000);
        const actualDiagnostics = vscode.languages.getDiagnostics(document.uri);
        assert.strictEqual(actualDiagnostics?.length, 0);
    });

    test('Lint matches validateFiles spectral', async () => {
        await deleteWorspaceConfiguration();
        await vscode.workspace.getConfiguration('spectral').update('validateFiles', ['**/*-openapi.yml']);
        const document = await helper.openFileAndWait(petstoreOpenapiFile, 2000);
        const actualDiagnostics = vscode.languages.getDiagnostics(document.uri);
        assert.strictEqual(actualDiagnostics?.length, 7);
    });

    test('Lint no matches validateFiles spectral', async () => {
        await deleteWorspaceConfiguration();
        await vscode.workspace.getConfiguration('spectral').update('validateFiles', ['**/*-no-matches.yml']);
        const document = await helper.openFileAndWait(petstoreOpenapiFile, 2000);
        const actualDiagnostics = vscode.languages.getDiagnostics(document.uri);
        assert.strictEqual(actualDiagnostics?.length, 0);
    });
});

async function deleteWorspaceConfiguration() {
    try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(vscode.Uri.file(__dirname), 'workspace', '.vscode', 'settings.json'));
        await helper.sleep(1000);
    } catch (ignored) {}
}
