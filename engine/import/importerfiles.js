import { RunTasks } from '../core/taskrunner.js';
import { FileSource, GetFileExtension, GetFileName, ReadFile, RequestUrl } from '../io/fileutils.js';

/**
 * File representation class for importers.
 */
export class InputFile {
    /**
     * @param {string} name Name of the file.
     * @param {FileSource} source Source of the file.
     * @param {string|File} data If the file source is url, this must be the url string. If the file source
     * is file, this must be a {@link File} object.
     */
    constructor(name, source, data) {
        console.log("data", data);
        this.name = name;
        this.source = source;
        this.data = data;
    }
}

export function InputFilesFromUrls(urls) {
    let inputFiles = [];
    for (let url of urls) {
        let fileName = GetFileName(url);
        inputFiles.push(new InputFile(fileName, FileSource.Url, url));
    }
    return inputFiles;
}

export function InputFilesFromFileObjects(fileObjects) {
    let inputFiles = [];
    for (let fileObject of fileObjects) {
        let fileName = GetFileName(fileObject.name);
        inputFiles.push(new InputFile(fileName, FileSource.File, fileObject));
    }
    return inputFiles;
}

export class ImporterFile {
    constructor(name, source, data) {
        this.name = GetFileName(name);
        this.extension = GetFileExtension(name);
        this.source = source;
        this.data = data;
        this.content = data; // Set content directly from data
    }

    SetContent(content) {
        this.content = content;
    }
}

export class ImporterFileList {
    constructor() {
        this.files = [];
    }

    FillFromInputFiles(inputFiles) {
        this.files = [];
        for (let inputFile of inputFiles) {
            console.log("inputFile", inputFile);
            let file = new ImporterFile(inputFile.name, inputFile.source, inputFile.data);
            console.log("Created ImporterFile", file);
            this.files.push(file);
        }
    }

    ExtendFromFileList(fileList) {
        let files = fileList.GetFiles();
        for (let i = 0; i < files.length; i++) {
            let file = files[i];
            if (!this.ContainsFileByPath(file.name)) {
                this.files.push(file);
            }
        }
    }

    GetFiles() {
        return this.files;
    }

    GetContent(callbacks) {
        RunTasks(this.files.length, {
            runTask: (index, onTaskComplete) => {
                callbacks.onFileListProgress(index, this.files.length);
                this.GetFileContent(this.files[index], {
                    onReady: onTaskComplete,
                    onProgress: callbacks.onFileLoadProgress
                });
            },
            onReady: callbacks.onReady
        });
    }

    ContainsFileByPath(filePath) {
        return this.FindFileByPath(filePath) !== null;
    }

    FindFileByPath(filePath) {
        let fileName = GetFileName(filePath).toLowerCase();
        for (let fileIndex = 0; fileIndex < this.files.length; fileIndex++) {
            let file = this.files[fileIndex];
            if (file.name.toLowerCase() === fileName) {
                return file;
            }
        }
        return null;
    }

    IsOnlyUrlSource() {
        if (this.files.length === 0) {
            return false;
        }
        for (let i = 0; i < this.files.length; i++) {
            let file = this.files[i];
            if (file.source !== FileSource.Url && file.source !== FileSource.Decompressed) {
                return false;
            }
        }
        return true;
    }

    AddFile(file) {
        this.files.push(file);
    }

    GetFileContent(file, callbacks) {
        console.log('GetFileContent called for file:', file.name);
        if (file.content !== null) {
            console.log('File content already set for file:', file.name);
            callbacks.onReady();
            return;
        }
        let loaderPromise = null;
        if (file.source === FileSource.Url) {
            console.log('Requesting URL for file:', file.name);
            loaderPromise = RequestUrl(file.data, callbacks.onProgress);
        } else if (file.source === FileSource.File) {
            console.log('Reading file for file:', file.name);
            loaderPromise = ReadFile(file.data, callbacks.onProgress);
        } else {
            console.log('Unknown file source for file:', file.name);
            callbacks.onReady();
            return;
        }
        loaderPromise.then((content) => {
            console.log('File content loaded for file:', file.name);
            file.SetContent(content);
        }).catch((error) => {
            console.error('Error loading file content for file:', file.name, error);
        }).finally(() => {
            callbacks.onReady();
        });
    }
}
