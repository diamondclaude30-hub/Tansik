"use strict";

// Low-level Bedrock Edition server built directly on top of bedrock-protocol.
// This file intentionally avoids high-level engines (PowerNukkit/PocketMine)
// and instead manually drives the login + world bootstrap packet flow.

const bedrock = require("bedrock-protocol");
const { randomUUID } = require("crypto");
const mcData = require("minecraft-data")("bedrock_1.21.0");
const Chunk = require("prismarine-chunk")("bedrock_1.21.0");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 19132;
const VERSION = "1.21.0";

// Constants for a super-flat world.
const SPAWN = { x: 0, y: 64, z: 0 };
const FLAT_HEIGHT = 64; // Y = 0..63
const CHUNK_RADIUS = 1; // send a 3x3 area around spawn.
const MAX_AIR_HEIGHT = 128; // keep payloads small while still above the player.
const DEFAULT_VIEW_DISTANCE = CHUNK_RADIUS;

const grassState = mcData.blocksByName.grass_block.defaultState;
const dirtState = mcData.blocksByName.dirt.defaultState;
const airState = mcData.blocksByName.air.defaultState;
const plainsBiomeId = mcData.biomesByName.plains?.id ?? 1;

const chunkCache = new Map();
const chunkPayloadCache = new Map();
const clients = new Set();
const players = new Map();

const server = bedrock.createServer({
  host: HOST,
  port: PORT,
  version: VERSION,
  offline: true,
  motd: "Low-Level Bedrock Node Server",
});

server.on("error", (error) => {
  console.error("Bedrock server error:", error);
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set PORT to a free port and retry.`);
  }
  process.exitCode = 1;
});

server.on("connect", (client) => {
  const playerState = {
    position: { ...SPAWN },
    rotation: { yaw: 0, pitch: 0, headYaw: 0 },
    onGround: true,
    lastBroadcast: { time: 0, position: { ...SPAWN } },
    username: "Player",
    uuid: randomUUID(),
  };
  client.loginState = {
    sawHandshake: false,
    packsCompleted: false,
    finished: false,
    stackSent: false,
  };
  client.chunkState = {
    radius: DEFAULT_VIEW_DISTANCE,
    sent: new Set(),
    lastChunk: { x: 0, z: 0 },
    lastPublisher: null,
  };
  client.playerState = playerState;
  clients.add(client);

  // 1) LOGIN
  client.on("login", (packet) => {
    playerState.username = packet.username ?? client.username ?? playerState.username;
    playerState.uuid = packet.uuid ?? client.uuid ?? playerState.uuid;
    playerState.skin = extractSkinData(packet, client) ?? playerState.skin;
    // Send the initial resource pack info (empty list).
    client.queue("resource_packs_info", {
      must_accept: false,
      has_scripts: false,
      force_server_packs: false,
      behavior_packs: [],
      texture_packs: [],
    });

    // Client responds with resource_pack_client_response. Then we send the stack.
    // The client answers with one or more resource_pack_client_response packets.
    // We send the empty stack once, then wait for the completion status.
    client.on("resource_pack_client_response", (response) => {
      if (!client.loginState.stackSent && response.status === "none") {
        client.loginState.stackSent = true;
        client.queue("resource_pack_stack", {
          must_accept: false,
          behavior_pack_stack: [],
          texture_pack_stack: [],
          game_version: VERSION,
          experiments: [],
          experiments_previously_toggled: false,
        });
      }

      if (response.status === "completed") {
        client.loginState.packsCompleted = true;
        maybeFinishLogin(client);
      } else if (response.status !== "none" && response.status !== "have_all") {
        console.warn(`Unexpected resource pack status: ${response.status}`);
      }
    });

    // The client sends client_to_server_handshake right after login.
    client.once("client_to_server_handshake", () => {
      client.loginState.sawHandshake = true;
      maybeFinishLogin(client);
    });
  });

  // Server-side tracking of player position from movement inputs.
  client.on("player_auth_input", (packet) => {
    if (!packet.position) {
      return;
    }

    playerState.position = {
      x: packet.position.x,
      y: packet.position.y,
      z: packet.position.z,
    };
    if (typeof packet.on_ground === "boolean") {
      playerState.onGround = packet.on_ground;
    }
    if (packet.yaw !== undefined || packet.pitch !== undefined || packet.head_yaw !== undefined) {
      playerState.rotation = {
        yaw: packet.yaw ?? playerState.rotation.yaw,
        pitch: packet.pitch ?? playerState.rotation.pitch,
        headYaw: packet.head_yaw ?? playerState.rotation.headYaw,
      };
    }

    maybeBroadcastMove(client, playerState);

    const currentChunk = {
      x: Math.floor(playerState.position.x / 16),
      z: Math.floor(playerState.position.z / 16),
    };

    if (
      currentChunk.x !== client.chunkState.lastChunk.x
      || currentChunk.z !== client.chunkState.lastChunk.z
    ) {
      client.chunkState.lastChunk = currentChunk;
      sendChunksAround(client, currentChunk);
    }
  });

  // Client can request a different chunk radius; respond with our cap.
  client.on("request_chunk_radius", (packet) => {
    const radius = Math.min(packet.chunk_radius ?? CHUNK_RADIUS, CHUNK_RADIUS);
    client.chunkState.radius = radius;
    client.queue("chunk_radius_update", { chunk_radius: radius });
    sendChunksAround(client, client.chunkState.lastChunk);
  });

  // Basic block placement/breaking via inventory transactions.
  client.on("inventory_transaction", (packet) => {
    if (!packet) {
      return;
    }

    const transactionType = packet.transaction_type;
    if (transactionType !== "item_use" && transactionType !== 2) {
      return;
    }

    const data = packet.data;
    if (!data?.block_position) {
      return;
    }

    const actionType = data.action_type;
    const isPlace = actionType === "place" || actionType === 0;
    const isBreak = actionType === "destroy" || actionType === "break" || actionType === 2;

    if (!isPlace && !isBreak) {
      return;
    }

    const basePosition = data.block_position;
    const targetPosition = isPlace
      ? offsetPositionByFace(basePosition, data.face)
      : basePosition;

    if (!targetPosition) {
      return;
    }

    if (isBreak) {
      if (setBlockStateAt(targetPosition, airState)) {
        broadcastBlockUpdate(targetPosition, airState);
      }
      return;
    }

    const stateId = resolveBlockStateFromItem(data.item_in_hand);
    if (!stateId) {
      return;
    }

    if (setBlockStateAt(targetPosition, stateId)) {
      broadcastBlockUpdate(targetPosition, stateId);
    }
  });

  // Basic chat handler for text packets.
  client.on("text", (packet) => {
    if (packet.message && packet.message.trim().length > 0) {
      console.log(`[CHAT] ${packet.source_name}: ${packet.message}`);
      client.queue("text", {
        type: "chat",
        needs_translation: false,
        source_name: "Server",
        message: `You said: ${packet.message}`,
        xuid: "",
        platform_chat_id: "",
      });
    }
  });

  client.on("disconnect", () => {
    console.log("Client disconnected.");
    client.chunkState.sent.clear();
    clients.delete(client);
    removePlayer(client);
  });

  console.log(`Client connected. Initial position: ${JSON.stringify(playerState.position)}`);
});

function sendSpawnChunks(client) {
  const spawnChunk = {
    x: Math.floor(SPAWN.x / 16),
    z: Math.floor(SPAWN.z / 16),
  };
  client.chunkState.lastChunk = spawnChunk;
  sendChunksAround(client, spawnChunk);
}

function generateFlatChunk() {
  const chunk = new Chunk();

  if (typeof chunk.setBiomeId === "function") {
    for (let x = 0; x < 16; x += 1) {
      for (let z = 0; z < 16; z += 1) {
        chunk.setBiomeId({ x, y: 0, z }, plainsBiomeId);
      }
    }
  }

  for (let x = 0; x < 16; x += 1) {
    for (let z = 0; z < 16; z += 1) {
      for (let y = 0; y < FLAT_HEIGHT; y += 1) {
        const state = y === FLAT_HEIGHT - 1 ? grassState : dirtState;
        chunk.setBlockStateId({ x, y, z }, state);
      }
      // Above the flat surface is air.
      for (let y = FLAT_HEIGHT; y < MAX_AIR_HEIGHT; y += 1) {
        chunk.setBlockStateId({ x, y, z }, airState);
      }
    }
  }

  return chunk;
}

function sendChunksAround(client, center) {
  const radius = client.chunkState.radius;

  updateChunkPublisher(client);

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const chunkX = center.x + dx;
      const chunkZ = center.z + dz;
      const key = `${chunkX},${chunkZ}`;

      if (client.chunkState.sent.has(key)) {
        continue;
      }

      const payload = getChunkPayload(chunkX, chunkZ);
      const subChunkCount = Math.max(
        Math.ceil(FLAT_HEIGHT / 16),
        Math.ceil(MAX_AIR_HEIGHT / 16),
      );

      client.queue("level_chunk", {
        chunk_x: chunkX,
        chunk_z: chunkZ,
        sub_chunk_count: subChunkCount,
        cache_enabled: false,
        payload,
      });

      client.chunkState.sent.add(key);
    }
  }

  pruneSentChunks(client, center, radius);
}

function maybeBroadcastMove(client, playerState) {
  const now = Date.now();
  const last = playerState.lastBroadcast;
  const dx = playerState.position.x - last.position.x;
  const dy = playerState.position.y - last.position.y;
  const dz = playerState.position.z - last.position.z;
  const movedEnough = dx * dx + dy * dy + dz * dz > 0.01;
  const timeElapsed = now - last.time > 100;

  if (!movedEnough && !timeElapsed) {
    return;
  }

  last.time = now;
  last.position = { ...playerState.position };
  broadcastMove(client, playerState);
}

function broadcastMove(client, playerState) {
  for (const other of clients) {
    if (other === client) {
      continue;
    }
    other.queue("move_player", {
      runtime_id: client.entityId,
      position: playerState.position,
      pitch: playerState.rotation.pitch,
      yaw: playerState.rotation.yaw,
      head_yaw: playerState.rotation.headYaw,
      mode: 0,
      on_ground: playerState.onGround,
      riding_runtime_id: 0,
    });
  }
}

function addPlayer(client) {
  const playerState = client.playerState;
  const skin = buildSkinPayload(playerState);
  players.set(client, {
    uuid: playerState.uuid,
    username: playerState.username,
    runtimeId: client.entityId,
  });

  const addEntry = {
    uuid: playerState.uuid,
    entity_unique_id: client.entityId,
    username: playerState.username,
    xuid: "",
    platform_chat_id: "",
    ...(skin ? { skin } : {}),
  };

  client.queue("player_list", {
    records: [addEntry],
    type: "add",
  });

  for (const other of clients) {
    if (other === client) {
      continue;
    }
    other.queue("player_list", {
      records: [addEntry],
      type: "add",
    });

    const otherState = other.playerState;
    const otherSkin = buildSkinPayload(otherState);
    const otherEntry = {
      uuid: otherState.uuid,
      entity_unique_id: other.entityId,
      username: otherState.username,
      xuid: "",
      platform_chat_id: "",
      ...(otherSkin ? { skin: otherSkin } : {}),
    };
    client.queue("player_list", {
      records: [otherEntry],
      type: "add",
    });

    client.queue("add_player", {
      uuid: otherState.uuid,
      username: otherState.username,
      entity_id: other.entityId,
      runtime_id: other.entityId,
      position: otherState.position,
      motion: { x: 0, y: 0, z: 0 },
      pitch: otherState.rotation.pitch,
      yaw: otherState.rotation.yaw,
      head_yaw: otherState.rotation.headYaw,
      held_item: { network_id: 0, count: 0, metadata: 0 },
      metadata: [],
      ...(otherSkin ? { skin: otherSkin } : {}),
      flags: 0,
      command_permissions: 0,
      action_permissions: 0,
      device_id: "",
      platform_chat_id: "",
      build_platform: 0,
    });

    other.queue("add_player", {
      uuid: playerState.uuid,
      username: playerState.username,
      entity_id: client.entityId,
      runtime_id: client.entityId,
      position: playerState.position,
      motion: { x: 0, y: 0, z: 0 },
      pitch: playerState.rotation.pitch,
      yaw: playerState.rotation.yaw,
      head_yaw: playerState.rotation.headYaw,
      held_item: { network_id: 0, count: 0, metadata: 0 },
      metadata: [],
      ...(skin ? { skin } : {}),
      flags: 0,
      command_permissions: 0,
      action_permissions: 0,
      device_id: "",
      platform_chat_id: "",
      build_platform: 0,
    });
  }
}

function removePlayer(client) {
  const playerState = client.playerState;
  if (!playerState) {
    return;
  }

  players.delete(client);

  for (const other of clients) {
    if (other === client) {
      continue;
    }
    other.queue("player_list", {
      records: [{
        uuid: playerState.uuid,
        entity_unique_id: client.entityId,
      }],
      type: "remove",
    });
    other.queue("remove_entity", { entity_unique_id: client.entityId });
  }
}

function extractSkinData(packet, client) {
  return packet?.skin_data
    ?? packet?.skinData
    ?? client?.skin_data
    ?? client?.skinData
    ?? null;
}

function buildSkinPayload(playerState) {
  if (!playerState?.skin) {
    return null;
  }
  return playerState.skin;
}

function updateChunkPublisher(client) {
  const playerPosition = client.playerState?.position ?? SPAWN;
  const current = {
    x: Math.floor(playerPosition.x),
    y: Math.floor(playerPosition.y),
    z: Math.floor(playerPosition.z),
  };

  if (
    client.chunkState.lastPublisher
    && client.chunkState.lastPublisher.x === current.x
    && client.chunkState.lastPublisher.z === current.z
    && client.chunkState.lastPublisher.y === current.y
  ) {
    return;
  }

  client.chunkState.lastPublisher = current;
  client.queue("network_chunk_publisher_update", {
    coordinates: current,
    radius: client.chunkState.radius,
  });
}

function getChunkPayload(chunkX, chunkZ) {
  const key = `${chunkX},${chunkZ}`;
  const cached = chunkPayloadCache.get(key);
  if (cached) {
    return cached;
  }

  const chunk = getChunk(chunkX, chunkZ);
  const payload = chunk.dump();
  chunkPayloadCache.set(key, payload);
  return payload;
}

function getChunk(chunkX, chunkZ) {
  const key = `${chunkX},${chunkZ}`;
  const cached = chunkCache.get(key);
  if (cached) {
    return cached;
  }

  const chunk = generateFlatChunk();
  chunkCache.set(key, chunk);
  return chunk;
}

function invalidateChunkPayload(chunkX, chunkZ) {
  const key = `${chunkX},${chunkZ}`;
  chunkPayloadCache.delete(key);
}

function resolveBlockStateFromItem(item) {
  if (!item) {
    return null;
  }

  const itemId = item.network_id ?? item.id;
  const mappedItem = typeof itemId === "number" ? mcData.itemsById?.[itemId] : null;
  const itemName = mappedItem?.name ?? item.name;
  if (!itemName) {
    return null;
  }

  const block = mcData.blocksByName[itemName];
  return block?.defaultState ?? null;
}

function setBlockStateAt(position, stateId) {
  if (!position) {
    return false;
  }

  const y = Math.floor(position.y);
  if (y < 0 || y >= MAX_AIR_HEIGHT) {
    return false;
  }

  const chunkX = Math.floor(position.x / 16);
  const chunkZ = Math.floor(position.z / 16);
  const localX = ((position.x % 16) + 16) % 16;
  const localZ = ((position.z % 16) + 16) % 16;

  const chunk = getChunk(chunkX, chunkZ);
  chunk.setBlockStateId({ x: localX, y, z: localZ }, stateId);
  invalidateChunkPayload(chunkX, chunkZ);
  return true;
}

function offsetPositionByFace(position, face) {
  if (!position || face === undefined || face === null) {
    return null;
  }

  const offsets = [
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 },
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
  ];

  const offset = offsets[face];
  if (!offset) {
    return null;
  }

  return {
    x: position.x + offset.x,
    y: position.y + offset.y,
    z: position.z + offset.z,
  };
}

function broadcastBlockUpdate(position, stateId) {
  for (const client of clients) {
    client.queue("update_block", {
      position,
      block_runtime_id: stateId,
      flags: 0,
      layer: 0,
    });
  }
}

function pruneSentChunks(client, center, radius) {
  for (const key of client.chunkState.sent) {
    const [xRaw, zRaw] = key.split(",");
    const chunkX = Number(xRaw);
    const chunkZ = Number(zRaw);

    if (Number.isNaN(chunkX) || Number.isNaN(chunkZ)) {
      client.chunkState.sent.delete(key);
      continue;
    }

    const distanceX = Math.abs(chunkX - center.x);
    const distanceZ = Math.abs(chunkZ - center.z);
    if (distanceX > radius + 1 || distanceZ > radius + 1) {
      client.chunkState.sent.delete(key);
    }
  }
}

function maybeFinishLogin(client) {
  if (!client.loginState?.sawHandshake || !client.loginState?.packsCompleted) {
    return;
  }
  if (client.loginState.finished) {
    return;
  }
  client.loginState.finished = true;

  client.queue("play_status", { status: "login_success" });

  // 2) START GAME
  // The start_game packet contains all world configuration and player spawn.
  client.queue("start_game", {
    entity_id: client.entityId,
    runtime_entity_id: client.entityId,
    player_gamemode: 1, // Creative
    player_position: { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z },
    pitch: 0,
    yaw: 0,
    world_seed: [0, 0],
    spawn_position: { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z },
    dimension: 0,
    generator: 1, // Flat
    world_gamemode: 1,
    difficulty: 1,
    world_name: "LowLevelFlat",
    level_id: "LowLevelFlat",
    has_circulation: false,
    xbox_live_auth_type: 0,
    level_time: 0,
    education_mode: false,
    rain_level: 0,
    lightning_level: 0,
    confirm_spawn: false,
    server_chunk_tick_radius: CHUNK_RADIUS,
    block_properties: [],
    itemstates: mcData.items.map((item) => ({
      name: item.name,
      id: item.id,
      component_based: false,
    })),
    player_permissions: 1,
    server_chunk_tick_range: CHUNK_RADIUS,
    behavior_packs: [],
    texture_packs: [],
    experiments: [],
    experiments_previously_toggled: false,
    server_authoritative_movement: "client_auth",
    game_version: VERSION,
    movement_type: "client_authoritative",
    server_engine: "bedrock-protocol",
    player_property_data: {
      int_properties: [],
      float_properties: [],
    },
    use_block_network_id: true,
  });

  client.queue("network_chunk_publisher_update", {
    coordinates: { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z },
    radius: client.chunkState.radius,
  });
  client.chunkState.lastPublisher = {
    x: Math.floor(SPAWN.x),
    y: Math.floor(SPAWN.y),
    z: Math.floor(SPAWN.z),
  };
  client.queue("set_spawn_position", {
    spawn_type: "player",
    position: { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z },
    dimension: 0,
  });
  client.queue("set_time", {
    time: 1000,
  });

  // 3) CHUNK STREAMING
  // We generate and send level_chunk packets around spawn so the player
  // spawns on solid ground instead of falling into the void.
  sendSpawnChunks(client);

  // 4) FINALIZE
  client.queue("set_local_player_as_initialized", {
    runtime_entity_id: client.entityId,
  });

  addPlayer(client);
}

console.log(`Bedrock server listening on ${HOST}:${PORT} (v${VERSION})`);
