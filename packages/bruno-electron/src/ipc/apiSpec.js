const { ipcMain } = require('electron');
const { utils } = require('@usebruno/common');
const { openApiSpecDialog, openApiSpec, validateApiSpec, broadcastWorkspaceConfig } = require('../app/apiSpecs');
const { writeFile, isDirectory, sanitizeName, validateName } = require('../utils/filesystem');
const { removeApiSpecUid } = require('../cache/apiSpecUids');
const {
  addApiSpecToWorkspace,
  removeApiSpecFromWorkspace,
  renameApiSpecInWorkspace,
  assertWritableApiSpecName,
  findApiSpecEntry,
  hasWorkspaceFile,
  readWorkspaceConfig
} = require('../utils/workspace-config');
const { getCertsAndProxyConfig } = require('./network/cert-utils');
const { makeAxiosInstance } = require('./network/axios-instance');
const { proxySwaggerFetch } = require('./swagger-fetch');
const LastOpenedWorkspaces = require('../store/last-opened-workspaces');
const path = require('path');
const fs = require('fs');

const isOpenedWorkspace = (lastOpenedWorkspaces, workspacePath) => {
  if (typeof workspacePath !== 'string' || !workspacePath) {
    return false;
  }

  const { defaultWorkspaceManager } = require('../store/default-workspace');
  const target = path.normalize(workspacePath);

  return [defaultWorkspaceManager.getDefaultWorkspacePath(), ...lastOpenedWorkspaces.getAll()]
    .filter(Boolean)
    .some((openedPath) => path.normalize(openedPath) === target);
};

// Clone and delete take a file path from the renderer, so they act only on a spec that a
// workspace the user has opened actually lists. A running watcher proves nothing here:
// renderer:open-api-spec-file watches any path with a spec extension, so trusting it would
// let two calls delete any yaml, yml or json file on the machine.
const assertKnownApiSpec = ({ lastOpenedWorkspaces }, pathname, workspacePath) => {
  if (typeof pathname !== 'string' || !pathname) {
    throw new Error('API spec path is required');
  }
  validateApiSpec(pathname);

  if (!isOpenedWorkspace(lastOpenedWorkspaces, workspacePath) || !hasWorkspaceFile(workspacePath)) {
    throw new Error(`workspace: ${workspacePath} is not an open workspace`);
  }

  if (!findApiSpecEntry(workspacePath, pathname)) {
    throw new Error(`api spec: ${pathname} is not listed in this workspace`);
  }
};

const renameApiSpec = async (deps, pathname, newName, workspacePath) => {
  assertKnownApiSpec(deps, pathname, workspacePath);
  const { mainWindow } = deps;

  const updatedConfig = await renameApiSpecInWorkspace(workspacePath, pathname, newName);
  broadcastWorkspaceConfig(mainWindow, workspacePath, updatedConfig);
};

const cloneApiSpec = async (deps, sourcePathname, newName, targetLocation, workspacePath) => {
  const { mainWindow, watcher } = deps;
  const trimmedName = assertWritableApiSpecName(newName);
  const filename = sanitizeName(trimmedName);
  if (!filename || !validateName(filename)) {
    throw new Error(utils.validateNameError(filename));
  }

  assertKnownApiSpec(deps, sourcePathname, workspacePath);
  if (!fs.statSync(sourcePathname, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`api spec: ${sourcePathname} does not exist`);
  }

  if (typeof targetLocation !== 'string' || !isDirectory(targetLocation)) {
    throw new Error(`path: ${targetLocation} is not an existing directory`);
  }

  const targetPathname = path.join(targetLocation, `${filename}${path.extname(sourcePathname)}`);
  if (fs.existsSync(targetPathname)) {
    throw new Error(`path: ${targetPathname} already exists`);
  }

  await fs.promises.copyFile(sourcePathname, targetPathname, fs.constants.COPYFILE_EXCL);

  // Add the entry first, so the copy keeps the typed name. openApiSpec would otherwise
  // name it after the spec's info.title, which is the source spec's name.
  if (hasWorkspaceFile(workspacePath)) {
    try {
      await addApiSpecToWorkspace(workspacePath, { name: trimmedName, path: targetPathname });
    } catch (error) {
      // Surface why the clone failed, not why the cleanup failed: on Windows this rm can
      // throw EBUSY or EPERM, which would otherwise replace the real error.
      await fs.promises.rm(targetPathname, { force: true }).catch((cleanupError) => {
        console.error('Failed to remove the cloned API spec after a failed workspace write:', cleanupError);
      });
      throw error;
    }
    broadcastWorkspaceConfig(mainWindow, workspacePath, readWorkspaceConfig(workspacePath));
  }

  await openApiSpec(mainWindow, watcher, targetPathname, { workspacePath });
  return targetPathname;
};

const deleteApiSpec = async (deps, pathname, workspacePath = null) => {
  assertKnownApiSpec(deps, pathname, workspacePath);
  const { mainWindow, watcher } = deps;

  await fs.promises.rm(pathname, { force: true });
  watcher.removeWatcher(pathname, mainWindow);
  removeApiSpecUid(pathname);

  if (hasWorkspaceFile(workspacePath)) {
    const { updatedConfig } = await removeApiSpecFromWorkspace(workspacePath, pathname);
    broadcastWorkspaceConfig(mainWindow, workspacePath, updatedConfig);
  }
};

const registerRendererEventHandlers = (mainWindow, watcher, lastOpenedApiSpecs) => {
  const deps = { mainWindow, watcher, lastOpenedWorkspaces: new LastOpenedWorkspaces() };

  ipcMain.handle('renderer:open-api-spec', (event, workspacePath = null) => {
    if (watcher && mainWindow) {
      return openApiSpecDialog(mainWindow, watcher, { workspacePath });
    }

    return null;
  });

  ipcMain.handle('renderer:open-api-spec-file', (event, apiSpecPath, workspacePath = null) => {
    if (watcher && mainWindow) {
      openApiSpec(mainWindow, watcher, apiSpecPath, { workspacePath });
    }
  });

  ipcMain.handle('renderer:save-api-spec', async (event, pathname, content) => {
    try {
      await writeFile(pathname, content);
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:create-api-spec', async (event, apiSpecName, apiSpecLocation, content = '', workspacePath = null) => {
    try {
      if (typeof apiSpecName !== 'string' || apiSpecName !== path.basename(apiSpecName)) {
        throw new Error(`api spec: ${apiSpecName} is not a valid filename`);
      }
      validateApiSpec(apiSpecName);

      if (typeof apiSpecLocation !== 'string' || !isDirectory(apiSpecLocation)) {
        throw new Error(`path: ${apiSpecLocation} is not an existing directory`);
      }

      let pathname = path.join(apiSpecLocation, apiSpecName);
      if (fs.existsSync(pathname)) {
        throw new Error(`path: ${pathname} already exists`);
      }
      await writeFile(pathname, content);
      await openApiSpec(mainWindow, watcher, pathname, { workspacePath });
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:remove-api-spec', async (event, pathname, workspacePath = null) => {
    try {
      if (watcher && mainWindow) {
        watcher.removeWatcher(pathname, mainWindow);
        removeApiSpecUid(pathname);

        if (hasWorkspaceFile(workspacePath)) {
          await removeApiSpecFromWorkspace(workspacePath, pathname);
        }
      }
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:rename-api-spec', (event, pathname, newName, workspacePath) =>
    renameApiSpec(deps, pathname, newName, workspacePath));

  ipcMain.handle('renderer:clone-api-spec', (event, sourcePathname, newName, targetLocation, workspacePath) =>
    cloneApiSpec(deps, sourcePathname, newName, targetLocation, workspacePath));

  ipcMain.handle('renderer:delete-api-spec', (event, pathname, workspacePath = null) =>
    deleteApiSpec(deps, pathname, workspacePath));

  ipcMain.handle('renderer:fetch-api-spec', async (event, url) => {
    try {
      // Use a proxy-aware axios instance so that the user's configured proxy
      const { proxyMode, proxyConfig, httpsAgentRequestFields, interpolationOptions }
        = await getCertsAndProxyConfig({
          collectionUid: null,
          collection: { promptVariables: {} },
          request: {},
          envVars: {},
          runtimeVariables: {},
          processEnvVars: {},
          collectionPath: '',
          globalEnvironmentVariables: {}
        });

      const axiosInstance = makeAxiosInstance({ proxyMode, proxyConfig, httpsAgentRequestFields, interpolationOptions });
      const response = await axiosInstance.get(url, {
        timeout: 30000,
        transformResponse: [(data) => data]
      });
      return response.data;
    } catch (error) {
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:swagger-fetch', async (event, req) => {
    return proxySwaggerFetch(req);
  });

  ipcMain.handle('renderer:ensure-apispec-folder', async (event, workspacePath) => {
    try {
      const apiSpecPath = path.join(workspacePath, 'apispec');
      if (!fs.existsSync(apiSpecPath)) {
        fs.mkdirSync(apiSpecPath, { recursive: true });
      }
      return apiSpecPath;
    } catch (error) {
      return Promise.reject(error);
    }
  });
};

const registerMainEventHandlers = (mainWindow, watcher, lastOpenedApiSpecs) => {
  ipcMain.handle('main:open-api-spec', () => {
    if (watcher && mainWindow) {
      openApiSpecDialog(mainWindow, watcher);
    }
  });
  ipcMain.on('main:apispec-opened', (win, pathname, uid, workspacePath = null) => {
    watcher.addWatcher(win, pathname, uid, {}, workspacePath);
  });
};

const registerApiSpecIpc = (mainWindow, watcher, lastOpenedApiSpecs) => {
  registerRendererEventHandlers(mainWindow, watcher, lastOpenedApiSpecs);
  registerMainEventHandlers(mainWindow, watcher, lastOpenedApiSpecs);
};

module.exports = registerApiSpecIpc;
module.exports.renameApiSpec = renameApiSpec;
module.exports.cloneApiSpec = cloneApiSpec;
module.exports.deleteApiSpec = deleteApiSpec;
