import { RunTaskAsync } from '../core/taskrunner.js';
import { FileSource, GetFileName } from '../io/fileutils.js';
import { RGBColor } from '../model/color.js';
import { ImporterFile, ImporterFileList } from './importerfiles.js';
import { Importer3dm } from './importer3dm.js';
import { Importer3ds } from './importer3ds.js';
import { ImporterGltf } from './importergltf.js';
import { ImporterIfc } from './importerifc.js';
import { ImporterObj } from './importerobj.js';
import { ImporterOff } from './importeroff.js';
import { ImporterPly } from './importerply.js';
import { ImporterOcct } from './importerocct.js';
import { ImporterStl } from './importerstl.js';
import { ImporterBim } from './importerbim.js';
import { ImporterThreeAmf, ImporterThree3mf, ImporterThreeDae, ImporterThreeFbx, ImporterThreeWrl } from './importerthree.js';
import { ImporterFcstd } from './importerfcstd.js';
import { WaitWhile } from '../core/taskrunner.js';
import { Direction } from '../geometry/geometry.js';
import { Matrix } from '../geometry/matrix.js';
import { Transformation } from '../geometry/transformation.js';
import { Base64DataURIToArrayBuffer, CreateObjectUrl, GetFileExtensionFromMimeType } from '../io/bufferutils.js';
import { GetFileExtension } from '../io/fileutils.js';
import { PhongMaterial, TextureMap } from '../model/material.js';
import { Node } from '../model/node.js';
import { ConvertThreeColorToColor, ConvertThreeGeometryToMesh, ThreeLinearToSRGBColorConverter, ThreeSRGBToLinearColorConverter } from '../threejs/threeutils.js';
import { ImporterBase } from './importerbase.js';

// Access fflate from the global scope
const { unzipSync } = window.fflate;

// Access THREE and loaders from the global scope
const THREE = window.THREE;
const FBXLoader = window.FBXLoader;

export class ImportSettings {
    constructor() {
        this.defaultLineColor = new RGBColor(100, 100, 100);
        this.defaultColor = new RGBColor(200, 200, 200);
    }
}

export const ImportErrorCode = {
    NoImportableFile: 1,
    FailedToLoadFile: 2,
    ImportFailed: 3,
    UnknownError: 4
};

export class ImportError {
    constructor(code) {
        this.code = code;
        this.mainFile = null;
        this.message = null;
    }
}

export class ImportResult {
    constructor() {
        this.model = null;
        this.mainFile = null;
        this.upVector = null;
        this.usedFiles = null;
        this.missingFiles = null;
    }
}

export class ImporterFileAccessor {
    constructor(getBufferCallback) {
        this.getBufferCallback = getBufferCallback;
        this.fileBuffers = new Map();
    }

    GetFileBuffer(filePath) {
        let fileName = GetFileName(filePath);
        if (this.fileBuffers.has(fileName)) {
            return this.fileBuffers.get(fileName);
        }
        let buffer = this.getBufferCallback(fileName);
        this.fileBuffers.set(fileName, buffer);
        return buffer;
    }
}

export class Importer {
    constructor() {
        this.importers = [
            new ImporterObj(),
            new ImporterStl(),
            new ImporterOff(),
            new ImporterPly(),
            new Importer3ds(),
            new ImporterGltf(),
            new ImporterBim(),
            new Importer3dm(),
            new ImporterIfc(),
            new ImporterOcct(),
            new ImporterFcstd(),
            new ImporterThreeFbx(),
            new ImporterThreeDae(),
            new ImporterThreeWrl(),
            new ImporterThree3mf(),
            new ImporterThreeAmf()
        ];
        this.fileList = new ImporterFileList();
        this.model = null;
        this.usedFiles = [];
        this.missingFiles = [];
    }

    AddImporter(importer) {
        this.importers.push(importer);
    }

    ImportFiles(inputFiles, settings, callbacks) {
        callbacks.onLoadStart();
        this.LoadFiles(inputFiles, {
            onReady: () => {
                callbacks.onImportStart();
                RunTaskAsync(() => {
                    this.DecompressArchives(this.fileList, () => {
                        this.ImportLoadedFiles(settings, callbacks);
                    });
                });
            },
            onFileListProgress: callbacks.onFileListProgress,
            onFileLoadProgress: callbacks.onFileLoadProgress
        });
    }

    LoadFiles(inputFiles, callbacks) {
        let newFileList = new ImporterFileList();
        newFileList.FillFromInputFiles(inputFiles);

        let reset = false;
        if (this.HasImportableFile(newFileList)) {
            reset = true;
        } else {
            let foundMissingFile = false;
            for (let i = 0; i < this.missingFiles.length; i++) {
                let missingFile = this.missingFiles[i];
                if (newFileList.ContainsFileByPath(missingFile)) {
                    foundMissingFile = true;
                }
            }
            if (!foundMissingFile) {
                reset = true;
            } else {
                this.fileList.ExtendFromFileList(newFileList);
                reset = false;
            }
        }
        if (reset) {
            this.fileList = newFileList;
        }
        this.fileList.GetContent({
            onReady: callbacks.onReady,
            onFileListProgress: callbacks.onFileListProgress,
            onFileLoadProgress: callbacks.onFileLoadProgress
        });
    }

    ImportLoadedFiles(settings, callbacks) {
        let importableFiles = this.GetImportableFiles(this.fileList);
        if (importableFiles.length === 0) {
            callbacks.onImportError(new ImportError(ImportErrorCode.NoImportableFile));
            return;
        }

        if (importableFiles.length === 1 || !callbacks.onSelectMainFile) {
            let mainFile = importableFiles[0];
            this.ImportLoadedMainFile(mainFile, settings, callbacks);
        } else {
            let fileNames = importableFiles.map(importableFile => importableFile.file.name);
            callbacks.onSelectMainFile(fileNames, (mainFileIndex) => {
                if (mainFileIndex === null) {
                    callbacks.onImportError(new ImportError(ImportErrorCode.NoImportableFile));
                    return;
                }
                RunTaskAsync(() => {
                    let mainFile = importableFiles[mainFileIndex];
                    this.ImportLoadedMainFile(mainFile, settings, callbacks);
                });
            });
        }
    }

    ImportLoadedMainFile(mainFile, settings, callbacks) {
        if (mainFile === null || mainFile.file === null || mainFile.file.content === null) {
            let error = new ImportError(ImportErrorCode.FailedToLoadFile);
            if (mainFile !== null && mainFile.file !== null) {
                error.mainFile = mainFile.file.name;
            }
            callbacks.onImportError(error);
            return;
        }

        this.model = null;
        this.usedFiles = [];
        this.missingFiles = [];
        this.usedFiles.push(mainFile.file.name);

        let importer = mainFile.importer;
        let fileAccessor = new ImporterFileAccessor((fileName) => {
            let fileBuffer = null;
            let file = this.fileList.FindFileByPath(fileName);
            if (file === null || file.content === null) {
                this.missingFiles.push(fileName);
                fileBuffer = null;
            } else {
                this.usedFiles.push(fileName);
                fileBuffer = file.content;
            }
            return fileBuffer;
        });

        importer.Import(mainFile.file.name, mainFile.file.extension, mainFile.file.content, {
            getDefaultLineMaterialColor: () => {
                return settings.defaultLineColor;
            },
            getDefaultMaterialColor: () => {
                return settings.defaultColor;
            },
            getFileBuffer: (filePath) => {
                return fileAccessor.GetFileBuffer(filePath);
            },
            onSuccess: () => {
                this.model = importer.GetModel();
                let result = new ImportResult();
                result.mainFile = mainFile.file.name;
                result.model = this.model;
                result.usedFiles = this.usedFiles;
                result.missingFiles = this.missingFiles;
                result.upVector = importer.GetUpDirection();
                callbacks.onImportSuccess(result);
            },
            onError: () => {
                let error = new ImportError(ImportErrorCode.ImportFailed);
                error.mainFile = mainFile.file.name;
                error.message = importer.GetErrorMessage();
                callbacks.onImportError(error);
            },
            onComplete: () => {
                importer.Clear();
            }
        });
    }

    DecompressArchives(fileList, onReady) {
        let files = fileList.GetFiles();
        let archives = [];
        for (let file of files) {
            if (file.extension === 'zip') {
                archives.push(file);
            }
        }
        if (archives.length === 0) {
            onReady();
            return;
        }
        for (let i = 0; i < archives.length; i++) {
            const archiveFile = archives[i];
            const archiveBuffer = new Uint8Array(archiveFile.content);
            const decompressed = unzipSync(archiveBuffer);
            for (const fileName in decompressed) {
                if (Object.prototype.hasOwnProperty.call(decompressed, fileName)) {
                    let file = new ImporterFile(fileName, FileSource.Decompressed, null);
                    file.SetContent(decompressed[fileName].buffer);
                    fileList.AddFile(file);
                }
            }
        }
        onReady();
    }

    GetFileList() {
        return this.fileList;
    }

    HasImportableFile(fileList) {
        let importableFiles = this.GetImportableFiles(fileList);
        return importableFiles.length > 0;
    }

    GetImportableFiles(fileList) {
        function FindImporter(file, importers) {
            for (let importerIndex = 0; importerIndex < importers.length; importerIndex++) {
                let importer = importers[importerIndex];
                if (importer.CanImportExtension(file.extension)) {
                    return importer;
                }
            }
            return null;
        }

        let importableFiles = [];
        let files = fileList.GetFiles();
        for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
            let file = files[fileIndex];
            let importer = FindImporter(file, this.importers);
            if (importer !== null) {
                importableFiles.push({
                    file: file,
                    importer: importer
                });
            }
        }
        return importableFiles;
    }
}

export class ImporterThreeBase extends ImporterBase {
    constructor() {
        super();
        this.colorConverter = null;
    }

    CreateLoader(manager) {
        return null;
    }

    GetMainObject(loadedObject) {
        return loadedObject;
    }

    IsMeshVisible(mesh) {
        return true;
    }

    ClearContent() {
        this.loader = null;
        this.materialIdToIndex = null;
        this.objectUrlToFileName = null;
    }

    ResetContent() {
        this.loader = null;
        this.materialIdToIndex = new Map();
        this.objectUrlToFileName = new Map();
    }

    ImportContent(fileContent, onFinish) {
        this.LoadModel(fileContent, onFinish);
    }

    LoadModel(fileContent, onFinish) {
        let isAllLoadersDone = false;
        let loadingManager = new THREE.LoadingManager(() => {
            isAllLoadersDone = true;
        });

        const mainFileUrl = CreateObjectUrl(fileContent);
        loadingManager.setURLModifier((url) => {
            if (url === mainFileUrl) {
                return url;
            }
            const name = GetFileName(url);
            const extension = GetFileExtension(url);
            if (extension.length > 0) {
                const buffer = this.callbacks.getFileBuffer(url);
                if (buffer !== null) {
                    let objectUrl = CreateObjectUrl(buffer);
                    this.objectUrlToFileName.set(objectUrl, name);
                    return objectUrl;
                }
            }
            return url;
        });

        const threeLoader = this.CreateLoader(loadingManager);
        if (threeLoader === null) {
            onFinish();
            return;
        }

        threeLoader.load(mainFileUrl,
            (object) => {
                WaitWhile(() => {
                    if (isAllLoadersDone) {
                        this.OnThreeObjectsLoaded(object, onFinish);
                        return false;
                    }
                    return true;
                });
            },
            () => {
            },
            (err) => {
                this.SetError(err);
                onFinish();
            }
        );
    }

    OnThreeObjectsLoaded(loadedObject, onFinish) {
        function GetObjectTransformation(threeObject) {
            let matrix = new Matrix().CreateIdentity();
            threeObject.updateMatrix();
            if (threeObject.matrix !== undefined && threeObject.matrix !== null) {
                matrix.Set(threeObject.matrix.elements);
            }
            return new Transformation(matrix);
        }

        function AddObject(importer, model, threeObject, parentNode) {
            let node = new Node();
            if (threeObject.name !== undefined) {
                node.SetName(threeObject.name);
            }
            node.SetTransformation(GetObjectTransformation(threeObject));
            parentNode.AddChildNode(node);

            for (let childObject of threeObject.children) {
                AddObject(importer, model, childObject, node);
            }
            if (threeObject.isMesh && importer.IsMeshVisible(threeObject)) {
                let mesh = importer.ConvertThreeMesh(threeObject);
                let meshIndex = model.AddMesh(mesh);
                node.AddMeshIndex(meshIndex);
            }
        }

        let mainObject = this.GetMainObject(loadedObject);
        let rootNode = this.model.GetRootNode();
        rootNode.SetTransformation(GetObjectTransformation(mainObject));
        for (let childObject of mainObject.children) {
            AddObject(this, this.model, childObject, rootNode);
        }

        onFinish();
    }

    ConvertThreeMesh(threeMesh) {
        let mesh = null;
        if (Array.isArray(threeMesh.material)) {
            mesh = ConvertThreeGeometryToMesh(threeMesh.geometry, null, this.colorConverter);
            if (threeMesh.geometry.attributes.color === undefined || threeMesh.geometry.attributes.color === null) {
                let materialIndices = [];
                for (let i = 0; i < threeMesh.material.length; i++) {
                    const material = threeMesh.material[i];
                    const materialIndex = this.FindOrCreateMaterial(material);
                    materialIndices.push(materialIndex);
                }
                for (let i = 0; i < threeMesh.geometry.groups.length; i++) {
                    let group = threeMesh.geometry.groups[i];
                    let groupEnd = null;
                    if (group.count === Infinity) {
                        groupEnd = mesh.TriangleCount();
                    } else {
                        groupEnd = group.start / 3 + group.count / 3;
                    }
                    for (let j = group.start / 3; j < groupEnd; j++) {
                        let triangle = mesh.GetTriangle(j);
                        triangle.SetMaterial(materialIndices[group.materialIndex]);
                    }
                }
            }
        } else {
            const materialIndex = this.FindOrCreateMaterial(threeMesh.material);
            mesh = ConvertThreeGeometryToMesh(threeMesh.geometry, materialIndex, this.colorConverter);
        }
        if (threeMesh.name !== undefined && threeMesh.name !== null) {
            mesh.SetName(threeMesh.name);
        }
        return mesh;
    }

    FindOrCreateMaterial(threeMaterial) {
        if (this.materialIdToIndex.has(threeMaterial.id)) {
            return this.materialIdToIndex.get(threeMaterial.id);
        }
        let material = this.ConvertThreeMaterial(threeMaterial);
        let materialIndex = null;
        if (material !== null) {
            materialIndex = this.model.AddMaterial(material);
        }
        this.materialIdToIndex.set(threeMaterial.id, materialIndex);
        return materialIndex;
    }

    ConvertThreeMaterial(threeMaterial) {
        function CreateTexture(threeMap, objectUrlToFileName) {
            function GetDataUrl(img) {
                if (img.data !== undefined && img.data !== null) {
                    let imageData = new ImageData(img.width, img.height);
                    let imageSize = img.width * img.height * 4;
                    for (let i = 0; i < imageSize; i++) {
                        imageData.data[i] = img.data[i];
                    }
                    return THREE.ImageUtils.getDataURL(imageData);
                } else {
                    return THREE.ImageUtils.getDataURL(img);
                }
            }

            if (threeMap === undefined || threeMap === null) {
                return null;
            }

            if (threeMap.image === undefined || threeMap.image === null) {
                return null;
            }

            try {
                const dataUrl = GetDataUrl(threeMap.image);
                const base64Buffer = Base64DataURIToArrayBuffer(dataUrl);
                let texture = new TextureMap();
                let textureName = null;
                if (objectUrlToFileName.has(threeMap.image.src)) {
                    textureName = objectUrlToFileName.get(threeMap.image.src);
                } else if (threeMap.name !== undefined && threeMap.name !== null) {
                    textureName = threeMap.name + '.' + GetFileExtensionFromMimeType(base64Buffer.mimeType);
                } else {
                    textureName = 'Embedded_' + threeMap.id.toString() + '.' + GetFileExtensionFromMimeType(base64Buffer.mimeType);
                }
                texture.name = textureName;
                texture.mimeType = base64Buffer.mimeType;
                texture.buffer = base64Buffer.buffer;
                texture.rotation = threeMap.rotation;
                texture.offset.x = threeMap.offset.x;
                texture.offset.y = threeMap.offset.y;
                texture.scale.x = threeMap.repeat.x;
                texture.scale.y = threeMap.repeat.y;
                return texture;
            } catch (err) {
                return null;
            }
        }

        if (threeMaterial.name === THREE.Loader.DEFAULT_MATERIAL_NAME) {
            return null;
        }

        let material = new PhongMaterial();
        material.name = threeMaterial.name;
        material.color = this.ConvertThreeColor(threeMaterial.color);
        material.opacity = threeMaterial.opacity;
        material.transparent = threeMaterial.transparent;
        material.alphaTest = threeMaterial.alphaTest;
        if (threeMaterial.type === 'MeshPhongMaterial') {
            material.specular = this.ConvertThreeColor(threeMaterial.specular);
            material.shininess = threeMaterial.shininess / 100.0;
        }
        material.diffuseMap = CreateTexture(threeMaterial.map, this.objectUrlToFileName);
        material.normalMap = CreateTexture(threeMaterial.normalMap, this.objectUrlToFileName);
        material.bumpMap = CreateTexture(threeMaterial.bumpMap, this.objectUrlToFileName);

        return material;
    }

    ConvertThreeColor(threeColor) {
        if (this.colorConverter !== null) {
            threeColor = this.colorConverter.Convert(threeColor);
        }
        return ConvertThreeColorToColor(threeColor);
    }
}

export class ImporterThreeFbx extends ImporterThreeBase {
    constructor() {
        super();
        this.colorConverter = new ThreeLinearToSRGBColorConverter();
    }

    CanImportExtension(extension) {
        return extension === 'fbx';
    }

    GetUpDirection() {
        return Direction.Y;
    }

    CreateLoader(manager) {
        manager.addHandler(/\.tga$/i, new TGALoader(manager));
        return new FBXLoader(manager);
    }

    GetMainObject(loadedObject) {
        return loadedObject;
    }
}
