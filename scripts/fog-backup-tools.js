const MODULE_ID = "fog-backup-tools";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const fogTransfers = new Map();
const exportSaveRequests = new Map();
const exportFogTransfers = new Map();

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function getSceneId(listItem) {
  const element = listItem?.[0] ?? listItem;
  return (
    element?.dataset?.entryId ??
    element?.dataset?.documentId ??
    element?.dataset?.sceneId ??
    null
  );
}

function getSceneFogDocuments(sceneId) {
  const collection = game.collections.get("FogExploration");
  if (!collection) throw new Error("FogExploration collection was not found.");

  return [...collection.values()]
    .filter((fog) => {
      const fogSceneId = fog.scene?.id ?? fog.scene;
      return fogSceneId === sceneId;
    })
    .map((fog) => {
      const data = fog.toObject();
      return {
        user: data.user?.id ?? data.user,
        explored: data.explored ?? null,
        timestamp: data.timestamp ?? Date.now(),
      };
    });
}

async function flushCurrentFog(sceneId) {
  const requestId = foundry.utils.randomID();
  const acknowledgements = new Set();
  exportSaveRequests.set(requestId, acknowledgements);

  async function commitAndSaveLocalFog() {
    if (!canvas?.ready || canvas.scene?.id !== sceneId) return false;

    if (typeof canvas.fog?.commit === "function") {
      canvas.fog.commit();
    }

    await wait(300);

    if (canvas.fog?.save) {
      await canvas.fog.save({ share: true });
    }

    acknowledgements.add(game.user.id);
    return true;
  }

  await commitAndSaveLocalFog();

  game.socket.emit(SOCKET_CHANNEL, {
    action: "commitFogBeforeExport",
    requestId,
    sceneId,
  });

  await wait(3500);

  if (typeof canvas.fog?.commit === "function") {
    canvas.fog.commit();
  }

  await wait(300);

  if (canvas.fog?.save) {
    await canvas.fog.save({ share: true });
  }

  await wait(1000);

  const explored =
    canvas.fog?.exploration?.explored ??
    canvas.fog?.exploration?._source?.explored ??
    null;

  exportSaveRequests.delete(requestId);

  if (typeof explored !== "string" || !explored.startsWith("data:image/")) {
    throw new Error(
      "The saved fog does not contain valid image data. " +
        "The export was aborted to prevent creating an empty backup.",
    );
  }

  console.info(
    `${MODULE_ID} | Fog saved before export; ` +
      `${acknowledgements.size} client(s) acknowledged.`,
  );

  return [
    {
      user: game.user.id,
      explored,
      timestamp: Date.now(),
    },
  ];
}

async function exportFog(sceneId) {
  if (!game.user.isGM) return;

  const scene = game.scenes.get(sceneId);
  if (!scene) {
    ui.notifications.error("The selected scene could not be found.");
    return;
  }

  try {
    const fogDocuments = await flushCurrentFog(sceneId);

    const payload = {
      format: "fog-backup-tools",
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceScene: { id: scene.id, name: scene.name },
      fogDocuments,
    };

    const safeName =
      scene.name
        .trim()
        .replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "scene";

    foundry.utils.saveDataToFile(
      JSON.stringify(payload, null, 2),
      "application/json",
      `fog-${safeName}-${Date.now()}.json`,
    );

    ui.notifications.info(
      `Fog for “${scene.name}” was exported (${fogDocuments.length} user states).`,
    );
  } catch (error) {
    console.error(`${MODULE_ID} | Fog export failed`, error);
    ui.notifications.error(
      "Fog export failed. See the browser console for details.",
    );
  }
}

function chooseJsonFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0] ?? null;
        input.remove();
        resolve(file);
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

function getLocalUserFogExploration(sceneId) {
  const collection = game.collections.get("FogExploration");
  if (!collection) return null;

  return (
    [...collection.values()].find((fog) => {
      const fogSceneId = fog.scene?.id ?? fog.scene;
      const fogUserId = fog.user?.id ?? fog.user;
      return fogSceneId === sceneId && fogUserId === game.user.id;
    }) ?? null
  );
}

async function reloadImportedFogForLocalUser(sceneId) {
  if (!canvas?.ready || canvas.scene?.id !== sceneId) return;

  let fog = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    fog = getLocalUserFogExploration(sceneId);
    if (fog?.explored) break;
    await wait(250);
  }

  if (!fog?.explored) {
    console.error(
      `${MODULE_ID} | No imported fog was found for user ${game.user.name}.`,
    );
    ui.notifications.error(
      "The imported fog could not be found for this user.",
    );
    return;
  }

  await applyImportedFogLocally(sceneId, fog.explored);
}

async function applyImportedFogLocally(sceneId, explored) {
  if (!canvas?.ready || canvas.scene?.id !== sceneId) return;
  if (!explored || typeof canvas.fog?._applySharedExploration !== "function")
    return;

  try {
    await canvas.fog._applySharedExploration(explored);

    canvas.fog._updated = true;
    await canvas.fog.save({ share: false });

    canvas.perception.update(
      {
        refreshVision: true,
        refreshLighting: true,
      },
      true,
    );

    console.info(`${MODULE_ID} | Imported fog was applied and saved locally.`);

    if (!game.user.isGM) {
      await wait(750);
      await canvas.fog._applySharedExploration(explored);
      canvas.fog._updated = true;
      await canvas.fog.save({ share: false });

      canvas.perception.update(
        {
          refreshVision: true,
          refreshLighting: true,
        },
        true,
      );

      console.info(
        `${MODULE_ID} | Imported fog was reapplied on the player client.`,
      );
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to apply imported fog locally`, error);
    ui.notifications.error(
      "The imported fog could not be displayed on this client.",
    );
  }
}

function broadcastImportedFog(sceneId, explored) {
  if (!explored) return;

  const transferId = foundry.utils.randomID();
  const chunkSize = 60000;
  const chunks = [];

  for (let offset = 0; offset < explored.length; offset += chunkSize) {
    chunks.push(explored.slice(offset, offset + chunkSize));
  }

  game.socket.emit(SOCKET_CHANNEL, {
    action: "fogTransferStart",
    transferId,
    sceneId,
    totalChunks: chunks.length,
  });

  chunks.forEach((chunk, index) => {
    game.socket.emit(SOCKET_CHANNEL, {
      action: "fogTransferChunk",
      transferId,
      index,
      chunk,
    });
  });

  game.socket.emit(SOCKET_CHANNEL, {
    action: "fogTransferEnd",
    transferId,
  });

  console.info(
    `${MODULE_ID} | Fog transfer ${transferId} was sent in ${chunks.length} chunks.`,
  );
}

async function replaceSceneFog(sceneId, fogDocuments) {
  const collection = game.collections.get("FogExploration");
  if (!collection) {
    throw new Error("FogExploration collection was not found.");
  }

  const FogExploration = CONFIG.FogExploration.documentClass;

  if (canvas?.ready && canvas.scene?.id === sceneId && canvas.fog?.reset) {
    await canvas.fog.reset();
  } else {
    const currentSceneFogIds = [...collection.values()]
      .filter((fog) => {
        const fogSceneId = fog.scene?.id ?? fog.scene;
        return fogSceneId === sceneId;
      })
      .map((fog) => fog.id);

    if (currentSceneFogIds.length) {
      await FogExploration.deleteDocuments(currentSceneFogIds);
    }
  }

  await new Promise((resolve) => window.setTimeout(resolve, 500));

  const documents = [];
  let skipped = 0;

  if (fogDocuments.length === 1) {
    const shared = fogDocuments[0];

    for (const user of game.users) {
      documents.push({
        scene: sceneId,
        user: user.id,
        explored: shared.explored ?? null,
        timestamp: Date.now(),
      });
    }
  } else {
    const validUsers = new Set(game.users.map((user) => user.id));

    for (const data of fogDocuments) {
      const userId = data?.user?.id ?? data?.user;

      if (!userId || !validUsers.has(userId)) {
        skipped++;
        continue;
      }

      documents.push({
        scene: sceneId,
        user: userId,
        explored: data.explored ?? null,
        timestamp: Date.now(),
      });
    }
  }

  if (documents.length) {
    await FogExploration.createDocuments(documents);
  }

  await new Promise((resolve) => window.setTimeout(resolve, 500));

  const explored = fogDocuments[0]?.explored ?? null;
  if (explored) {
    await applyImportedFogLocally(sceneId, explored);
    broadcastImportedFog(sceneId, explored);
  } else {
    await refreshFogForScene(sceneId);
  }

  return {
    imported: documents.length,
    skipped,
  };
}

async function refreshFogForScene(sceneId) {
  if (!canvas?.ready || canvas.scene?.id !== sceneId) return;

  try {
    if (canvas.fog?.load) {
      await canvas.fog.load({ preserve: false });
    }

    canvas.perception.update(
      {
        refreshVision: true,
        refreshLighting: true,
      },
      true,
    );

    console.info(`${MODULE_ID} | Fog for scene ${sceneId} was reloaded.`);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to reload fog`, error);
  }
}

function broadcastFogRefresh(sceneId) {
  game.socket.emit(SOCKET_CHANNEL, {
    action: "refreshFog",
    sceneId,
  });
}

async function importFog(sceneId) {
  if (!game.user.isGM) return;

  const scene = game.scenes.get(sceneId);
  if (!scene) {
    ui.notifications.error("The selected scene could not be found.");
    return;
  }

  const file = await chooseJsonFile();
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());

    if (
      payload?.format !== "fog-backup-tools" ||
      !Array.isArray(payload?.fogDocuments)
    ) {
      throw new Error(
        "The selected file is not a valid fog export created by this module.",
      );
    }

    const DialogV2 = foundry.applications.api.DialogV2;
    const confirmed = await DialogV2.confirm({
      window: { title: "Import Fog" },
      content: `
        <p>The current Fog of War for scene <strong>${foundry.utils.escapeHTML(scene.name)}</strong>
        will be completely replaced by the state stored in the selected file.</p>
        <p>Source: <strong>${foundry.utils.escapeHTML(payload.sourceScene?.name ?? "Unknown")}</strong><br>
        Stored user states: <strong>${payload.fogDocuments.length}</strong></p>
        <p>Continue?</p>
      `,
      yes: { label: "Import Fog" },
      no: { label: "Cancel" },
      modal: true,
    });

    if (!confirmed) return;

    const result = await replaceSceneFog(sceneId, payload.fogDocuments);

    ui.notifications.info(
      `Fog for “${scene.name}” was reset and imported: ` +
        `${result.imported} user states` +
        (result.skipped ? `, ${result.skipped} skipped.` : "."),
    );
  } catch (error) {
    console.error(`${MODULE_ID} | Fog import failed`, error);
    ui.notifications.error(
      `Fog import failed: ${error.message ?? "Unknowner Fehler"}`,
    );
  }
}

function addSceneContextOptions(options) {
  if (!game.user.isGM) return options;

  if (!options.some((option) => option.label === "Export Fog")) {
    options.push({
      label: "Export Fog",
      icon: "fa-solid fa-file-export",
      visible: (listItem) => Boolean(getSceneId(listItem)),
      onClick: (_event, listItem) => {
        const sceneId = getSceneId(listItem);
        if (sceneId) void exportFog(sceneId);
      },
    });
  }

  if (!options.some((option) => option.label === "Import Fog")) {
    options.push({
      label: "Import Fog",
      icon: "fa-solid fa-file-import",
      visible: (listItem) => Boolean(getSceneId(listItem)),
      onClick: (_event, listItem) => {
        const sceneId = getSceneId(listItem);
        if (sceneId) void importFog(sceneId);
      },
    });
  }

  return options;
}

function getCurrentSceneId() {
  return canvas?.scene?.id ?? game.scenes?.active?.id ?? null;
}

function createHeaderButtons() {
  const wrapper = document.createElement("div");
  wrapper.id = "fog-backup-tools-buttons";
  wrapper.classList.add("flexrow");

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.innerHTML = '<i class="fa-solid fa-file-export"></i> Export Fog';
  exportButton.title = "Export the Fog of War for the currently active scene";
  exportButton.addEventListener("click", () => {
    const sceneId = getCurrentSceneId();
    if (!sceneId) {
      ui.notifications.warn("Open the desired scene first.");
      return;
    }
    void exportFog(sceneId);
  });

  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.innerHTML = '<i class="fa-solid fa-file-import"></i> Import Fog';
  importButton.title = "Import Fog of War into the currently active scene";
  importButton.addEventListener("click", () => {
    const sceneId = getCurrentSceneId();
    if (!sceneId) {
      ui.notifications.warn("Open the desired scene first.");
      return;
    }
    void importFog(sceneId);
  });

  wrapper.append(exportButton, importButton);
  return wrapper;
}

function normalizeRoot(root) {
  if (!root) return null;
  if (root instanceof HTMLElement) return root;
  if (root?.[0] instanceof HTMLElement) return root[0];
  if (root?.element instanceof HTMLElement) return root.element;
  if (root?.element?.[0] instanceof HTMLElement) return root.element[0];
  return null;
}

function injectSceneDirectoryButtons(application, html) {
  if (!game.user?.isGM) return false;

  const root =
    normalizeRoot(html) ??
    normalizeRoot(application?.element) ??
    normalizeRoot(ui.scenes?.element);

  if (!root) {
    console.warn(`${MODULE_ID} | Scene directory root element was not found.`);
    return false;
  }

  if (root.querySelector("#fog-backup-tools-buttons")) return true;

  const buttons = [...root.querySelectorAll("button")];
  const createSceneButton = buttons.find((button) => {
    const action = button.dataset?.action ?? "";
    const text = button.textContent?.trim().toLowerCase() ?? "";
    return (
      (action.includes("create") && action.includes("scene")) ||
      text.includes("create scene")
    );
  });

  const createFolderButton = buttons.find((button) => {
    const action = button.dataset?.action ?? "";
    const text = button.textContent?.trim().toLowerCase() ?? "";
    return (
      (action.includes("create") && action.includes("folder")) ||
      text.includes("create folder")
    );
  });

  let target =
    createSceneButton?.parentElement ?? createFolderButton?.parentElement;

  if (!target) {
    target =
      root.querySelector(".directory-header .action-buttons") ??
      root.querySelector(".directory-header") ??
      root.querySelector("header") ??
      root;
  }

  target.appendChild(createHeaderButtons());

  console.info(`${MODULE_ID} | Fog buttons were added.`, {
    root,
    target,
  });
  return true;
}

function installSceneContextMenuEntries() {
  const directory = ui.scenes;
  if (!directory || directory._fogBackupToolsPatched) return;

  const original = directory._getEntryContextOptions;
  if (typeof original !== "function") {
    console.warn(`${MODULE_ID} | _getEntryContextOptions was not found.`);
    return;
  }

  directory._getEntryContextOptions = function (...args) {
    const options = original.apply(this, args);

    if (!options.some((option) => option.label === "Export Fog")) {
      options.push({
        label: "Export Fog",
        icon: "fa-solid fa-file-export",
        visible: (listItem) => Boolean(getSceneId(listItem)),
        onClick: (_event, listItem) => {
          const sceneId = getSceneId(listItem);
          if (sceneId) void exportFog(sceneId);
        },
      });
    }

    if (!options.some((option) => option.label === "Import Fog")) {
      options.push({
        label: "Import Fog",
        icon: "fa-solid fa-file-import",
        visible: (listItem) => Boolean(getSceneId(listItem)),
        onClick: (_event, listItem) => {
          const sceneId = getSceneId(listItem);
          if (sceneId) void importFog(sceneId);
        },
      });
    }

    return options;
  };

  directory._fogBackupToolsPatched = true;

  if (typeof directory._createContextMenus === "function") {
    directory._createContextMenus();
  }

  console.info(`${MODULE_ID} | Context menu was extended.`);
}

Hooks.on("renderSceneDirectory", (application, html) => {
  window.setTimeout(() => injectSceneDirectoryButtons(application, html), 0);
});

Hooks.on("renderApplicationV2", (application, html) => {
  if (
    application === ui.scenes ||
    application?.constructor?.name === "SceneDirectory"
  ) {
    window.setTimeout(() => injectSceneDirectoryButtons(application, html), 0);
  }
});

function sendFogSnapshotChunks(
  actionPrefix,
  requestId,
  sceneId,
  userId,
  explored,
) {
  const transferId = foundry.utils.randomID();
  const chunkSize = 60000;
  const chunks = [];

  for (let offset = 0; offset < explored.length; offset += chunkSize) {
    chunks.push(explored.slice(offset, offset + chunkSize));
  }

  game.socket.emit(SOCKET_CHANNEL, {
    action: `${actionPrefix}Start`,
    requestId,
    transferId,
    sceneId,
    userId,
    totalChunks: chunks.length,
  });

  chunks.forEach((chunk, index) => {
    game.socket.emit(SOCKET_CHANNEL, {
      action: `${actionPrefix}Chunk`,
      requestId,
      transferId,
      index,
      chunk,
    });
  });

  game.socket.emit(SOCKET_CHANNEL, {
    action: `${actionPrefix}End`,
    requestId,
    transferId,
  });
}

Hooks.once("ready", () => {
  game.socket.on(SOCKET_CHANNEL, async (payload) => {
    if (!payload?.action) return;

    if (payload.action === "commitFogBeforeExport") {
      if (canvas?.ready && canvas.scene?.id === payload.sceneId) {
        try {
          if (typeof canvas.fog?.commit === "function") {
            canvas.fog.commit();
          }

          await wait(250);

          if (canvas.fog?.save) {
            await canvas.fog.save({ share: true });
          }

          game.socket.emit(SOCKET_CHANNEL, {
            action: "commitFogBeforeExportAck",
            requestId: payload.requestId,
            userId: game.user.id,
          });
        } catch (error) {
          console.error(
            `${MODULE_ID} | Failed to commit fog before export.`,
            error,
          );
        }
      }
      return;
    }

    if (payload.action === "commitFogBeforeExportAck") {
      const acknowledgements = exportSaveRequests.get(payload.requestId);
      if (acknowledgements) acknowledgements.add(payload.userId);
      return;
    }

    if (payload.action === "captureFogForExport") {
      if (
        canvas?.ready &&
        canvas.scene?.id === payload.sceneId &&
        typeof canvas.fog?._extractBase64 === "function"
      ) {
        try {
          canvas.perception.update(
            {
              refreshVision: true,
              refreshLighting: true,
            },
            true,
          );

          await wait(750);

          if (canvas.fog?.save) {
            await canvas.fog.save({ share: true });
          }

          await wait(250);

          const explored = await canvas.fog._extractBase64();

          sendFogSnapshotChunks(
            "exportFogTransfer",
            payload.requestId,
            payload.sceneId,
            game.user.id,
            explored,
          );
        } catch (error) {
          console.error(
            `${MODULE_ID} | Failed to capture an exact fog snapshot.`,
            error,
          );
        }
      }
      return;
    }

    if (payload.action === "exportFogTransferStart") {
      let requestTransfers = exportFogTransfers.get(payload.requestId);
      if (!requestTransfers) {
        requestTransfers = new Map();
        exportFogTransfers.set(payload.requestId, requestTransfers);
      }

      requestTransfers.set(payload.transferId, {
        userId: payload.userId,
        totalChunks: payload.totalChunks,
        chunks: new Array(payload.totalChunks),
      });
      return;
    }

    if (payload.action === "exportFogTransferChunk") {
      const transfer = exportFogTransfers
        .get(payload.requestId)
        ?.get(payload.transferId);

      if (transfer) transfer.chunks[payload.index] = payload.chunk;
      return;
    }

    if (payload.action === "exportFogTransferEnd") {
      const requestTransfers = exportFogTransfers.get(payload.requestId);
      const transfer = requestTransfers?.get(payload.transferId);
      if (!transfer) return;

      const complete =
        transfer.chunks.length === transfer.totalChunks &&
        transfer.chunks.every((chunk) => typeof chunk === "string");

      if (complete) {
        const responses = exportSaveRequests.get(payload.requestId);
        responses?.set(transfer.userId, {
          user: transfer.userId,
          explored: transfer.chunks.join(""),
          timestamp: Date.now(),
        });
      }

      requestTransfers.delete(payload.transferId);
      return;
    }

    if (payload.action === "saveFogBeforeExport") {
      if (
        canvas?.ready &&
        canvas.scene?.id === payload.sceneId &&
        canvas.fog?.save
      ) {
        try {
          await canvas.fog.save({ share: true });

          game.socket.emit(SOCKET_CHANNEL, {
            action: "saveFogBeforeExportAck",
            requestId: payload.requestId,
            userId: game.user.id,
          });
        } catch (error) {
          console.error(
            `${MODULE_ID} | Fog could not be saved before export.`,
            error,
          );
        }
      }
      return;
    }

    if (payload.action === "saveFogBeforeExportAck") {
      const acknowledgements = exportSaveRequests.get(payload.requestId);
      if (acknowledgements) acknowledgements.add(payload.userId);
      return;
    }

    if (payload.action === "fogTransferStart") {
      fogTransfers.set(payload.transferId, {
        sceneId: payload.sceneId,
        totalChunks: payload.totalChunks,
        chunks: new Array(payload.totalChunks),
      });
      return;
    }

    if (payload.action === "fogTransferChunk") {
      const transfer = fogTransfers.get(payload.transferId);
      if (!transfer) return;
      transfer.chunks[payload.index] = payload.chunk;
      return;
    }

    if (payload.action === "fogTransferEnd") {
      const transfer = fogTransfers.get(payload.transferId);
      if (!transfer) return;

      const complete =
        transfer.chunks.length === transfer.totalChunks &&
        transfer.chunks.every((chunk) => typeof chunk === "string");

      if (!complete) {
        console.error(`${MODULE_ID} | Fog transfer is incomplete.`, transfer);
        fogTransfers.delete(payload.transferId);
        return;
      }

      const explored = transfer.chunks.join("");
      fogTransfers.delete(payload.transferId);

      if (!game.user.isGM) {
        await wait(1500);
      }

      await applyImportedFogLocally(transfer.sceneId, explored);
      return;
    }

    if (payload.action === "refreshFog") {
      await refreshFogForScene(payload.sceneId);
    }
  });

  installSceneContextMenuEntries();

  window.setTimeout(
    () => injectSceneDirectoryButtons(ui.scenes, ui.scenes?.element),
    250,
  );

  const observer = new MutationObserver(() => {
    injectSceneDirectoryButtons(ui.scenes, ui.scenes?.element);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.info(`${MODULE_ID} | Ready`);
});
