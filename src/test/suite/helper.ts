import * as vscode from 'vscode';
import { ConfigurationTarget } from 'vscode';
import { Configuration } from '../../extension';

export async function doc(content: string, language?: string) {
    return await vscode.workspace.openTextDocument({
        language,
        content,
    });
}

export async function openWorkspaceFolder(folder: string) {
    return await vscode.workspace.updateWorkspaceFolders(0, null, { uri: vscode.Uri.file(folder) });
}

export async function openFileAndWait(fsPath: string, timeout: number): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    if (timeout) {
        await sleep(timeout);
    }
    return document;
}

export async function openDocument(content: string, language?: string): Promise<vscode.TextDocument> {
    const document = await doc(content);
    await vscode.window.showTextDocument(document);
    return document;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}
