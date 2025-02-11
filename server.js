import { WebSocketServer } from 'ws'
import Player from './player.js'
import GameRoom from './gameroom.js'

const port = process.env.PORT || 8080
const wss = new WebSocketServer({ port: port })

// Set player timeout to 10 minutes
const PlayerTimeoutMs = 10 * 60 * 1000 * 99
const game_rooms = {}
const active_connections = new Map()

var running_id = 1
var running_match_id = 1
var awaiting_match_room = null

function join_custom_room(ws, join_room_json) {
  // Check if jsonObj is an object
  if (typeof join_room_json !== 'object' || join_room_json === null) {
    console.log("join_room_json is not an object")
    return false
  }
  // Check if 'room_id' and 'deck_id' fields exist in the object
  if (!('room_id' in join_room_json && 'deck_id' in join_room_json)) {
    console.log("join_room_json does not have 'room_id' and 'deck_id' fields")
    return false
  }
  if (!(typeof join_room_json.room_id === 'string' && typeof join_room_json.deck_id === 'string')) {
    console.log("join_room_json 'room_id' and 'deck_id' fields are not strings")
    return false
  }
  if (!('version' in join_room_json && typeof join_room_json.version === 'string')) {
    console.log("join_room_json does not have 'version' field")
    return false
  }
  var version = join_room_json.version

  var player = active_connections.get(ws)
  if (player === undefined) {
    console.log("join_room Player is undefined")
    return false
  }
  player.version = version

  if ('player_name' in join_room_json && typeof join_room_json.player_name === 'string') {
    set_name(player, join_room_json)
  }

  var room_id = join_room_json.room_id.trim()
  if (room_id == "Lobby") {
    const message = {
      type: 'room_join_failed',
      reason: "cannot_join_lobby"
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // If this is the awaiting match room, let them join it.
  if (awaiting_match_room == room_id) {
    join_matchmaking(ws, join_room_json)
  } else {
    // Add a prefix to the room id to indicate custom match.
    room_id = "custom_" + room_id

    var deck_id = join_room_json.deck_id
    var player = active_connections.get(ws)
    player.set_deck_id(deck_id)
    var success = false
    if (game_rooms.hasOwnProperty(room_id)) {
      const room = game_rooms[room_id]
      if (room.version != version) {
        // Player/Room version mismatch.
        send_join_version_error(ws)
        return true
      }
      success = room.join(player)
    } else {
      const new_room = new GameRoom(version, room_id)
      new_room.join(player)
      game_rooms[room_id] = new_room
      success = true
    }

    if (!success) {
      const message = {
        type: 'room_join_failed',
        reason: 'room_full'
      }
      ws.send(JSON.stringify(message))
    }
    broadcast_players_update()

    return true
  }
}

function observe_room(ws, json_data) {
  // Check if jsonObj is an object
  if (typeof json_data !== 'object' || json_data === null) {
    console.log("json_data is not an object")
    return false
  }
  // Check if 'room_id' exists in the object
  if (!('room_id' in json_data)) {
    console.log("json_data does not have 'room_id'")
    return false
  }
  if (!(typeof json_data.room_id === 'string')) {
    console.log("json_data 'room_id' is not a string")
    return false
  }
  if (!('version' in json_data && typeof json_data.version === 'string')) {
    console.log("json_data does not have 'version' field")
    return false
  }
  var version = json_data.version

  var player = active_connections.get(ws)
  if (player === undefined) {
    console.log("observe_room Player is undefined")
    return false
  }
  player.version = version

  if ('player_name' in json_data && typeof json_data.player_name === 'string') {
    set_name(player, json_data)
  }

  var room_id = json_data.room_id.trim()
  if (room_id == "Lobby") {
    const message = {
      type: 'room_join_failed',
      reason: "cannot_join_lobby"
    }
    ws.send(JSON.stringify(message))
    return true
  }

  // Find the match.
  // Search for the match as is, or with the custom_ prefix.
  var room = null
  if (game_rooms.hasOwnProperty(room_id)) {
    room = game_rooms[room_id]
  } else if (game_rooms.hasOwnProperty("custom_" + room_id)) {
    room = game_rooms["custom_" + room_id]
  }

  if (room != null) {
    if (room.version != version) {
      // Player/Room version mismatch.
      send_join_version_error(ws)
      return true
    }
    var success = room.observe(player)
    if (!success) {
      const message = {
        type: 'room_join_failed',
        reason: 'unknown_join_error'
      }
      ws.send(JSON.stringify(message))
    } else {
      // Success!
      broadcast_players_update()
    }
    return true
  } else {
    const message = {
      type: 'room_join_failed',
      reason: 'room_not_found'
    }
    ws.send(JSON.stringify(message))
    return true
  }
}

function send_join_version_error(ws) {
  const message = {
    type: 'room_join_failed',
    reason: 'version_mismatch'
  }
  ws.send(JSON.stringify(message))
}

function get_next_match_id() {
  var value = running_match_id++
  if (running_match_id > 999) {
    running_match_id = 1
  }
  return value
}

function create_new_match_room(version, player) {
  const room_id = "Match_" + get_next_match_id()
  const new_room = new GameRoom(version, room_id)
  new_room.join(player)
  game_rooms[room_id] = new_room
  awaiting_match_room = room_id
}

function join_matchmaking(ws, json_data) {
  // Check if jsonObj is an object
  if (typeof json_data !== 'object' || json_data === null) {
    console.log("join_matchmaking json is not an object")
    return false
  }
  // Check if 'room_id' and 'deck_id' fields exist in the object
  if (!('deck_id' in json_data)) {
    console.log("join_matchmaking  does not have 'deck_id' fields")
    return false
  }
  if (!(typeof json_data.deck_id === 'string' && typeof json_data.deck_id === 'string')) {
    console.log("join_matchmaking 'deck_id' fields are not strings")
    return false
  }
  if (!('version' in json_data && typeof json_data.version === 'string')) {
    console.log("join_matchmaking does not have 'version' field")
    return false
  }
  var version = json_data.version

  var player = active_connections.get(ws)
  if (player === undefined) {
    console.log("join_matchmaking Player is undefined")
    return false
  }

  if ('player_name' in json_data && typeof json_data.player_name === 'string') {
    set_name(player, json_data)
  }

  var deck_id = json_data.deck_id
  var player = active_connections.get(ws)
  player.set_deck_id(deck_id)
  var success = false
  if (awaiting_match_room === null) {
    // Create a new room and join it.
    create_new_match_room(version, player)
    success = true
  } else {
    if (game_rooms.hasOwnProperty(awaiting_match_room)) {
      const room = game_rooms[awaiting_match_room]
      if (room.version < version) {
        // The player joining has a larger version,
        // kick the player in the room and make a new one.
        var player_in_room = room.players[0]
        send_join_version_error(player_in_room.ws)
        leave_room(player_in_room, false)
        create_new_match_room(version, player)
        success = true
      } else if (room.version > version) {
        // Lower version than room, probably need to update.
        // Send error message.
        send_join_version_error(ws)
        return true
      } else {
        // Join the room successfully.
        success = room.join(player)
        awaiting_match_room = null
      }
    } else {
      // They must have disconnected.
      create_new_match_room(version, player)
      success = true
    }
  }

  if (!success) {
    const message = {
      type: 'room_join_failed',
      reason: 'matchmaking_failed'
    }
    ws.send(JSON.stringify(message))
  }

  broadcast_players_update()

  return true
}

function leave_room(player, disconnect) {
  if (player.room !== null) {
    var room_id = player.room.name
    if (awaiting_match_room == room_id) {
      awaiting_match_room = null
    }
    player.room.player_quit(player, disconnect)
    if (player.room.is_game_over) {
      console.log("Closing room " + room_id)
      delete game_rooms[room_id]
    }
    player.room = null
    broadcast_players_update()
  }
}

function handle_disconnect(ws) {
  const player = active_connections.get(ws)
  if (player) {
    console.log(`Player ${player.name} disconnected`)
    leave_room(player, true)
    active_connections.delete(ws)
    broadcast_players_update()
  }
}

function already_has_player_with_name(player_to_ignore, name) {
  for (const player in active_connections.values()) {
    if (player === player_to_ignore) {
      continue
    }

    if (player.name.toLowerCase() == name.toLowerCase()) {
      return true
    }
  }
  return false
}

function set_name(player, json_message) {
  if (!('player_name' in json_message && typeof json_message.player_name === 'string')) {
    console.log("set_name message does not have 'player_name' field")
    return
  }
  if (!('version' in json_message && typeof json_message.version === 'string')) {
    console.log("set_name does not have 'version' field")
    return false
  }
  var version = json_message.version

  var desired_name = json_message.player_name
  if (desired_name.length == 0 || player.name.toLowerCase() == desired_name.toLowerCase()) {
    desired_name = player.name
  }

  var name_to_set = desired_name
  while (already_has_player_with_name(player, desired_name)) {
    name_to_set = desired_name + "_" + get_next_id()
  }
  player.set_name(version, name_to_set)
  console.log("Player name set to " + name_to_set)
  broadcast_players_update()
}

function broadcast_players_update() {
  const message = {
    type: 'players_update',
    players: [],
    rooms: [],
    match_available: awaiting_match_room !== null
  }
  for (const player of active_connections.values()) {
    message.players.push({
      player_id: player.id,
      player_version: player.version,
      player_name: player.name,
      player_deck: player.deck_id,
      room_name: player.room === null ? "Lobby" : player.room.name
    })
  }
  for (const room_id of Object.keys(game_rooms)) {
    var room = game_rooms[room_id]
    message.rooms.push({
      room_name: room.name,
      room_version: room.version,
      player_count: room.players.length,
      observer_count: room.get_observer_count(),
      game_started: room.gameStarted,
      player_names: [room.get_player_name(0), room.get_player_name(1)],
      player_decks: [room.get_player_deck(0), room.get_player_deck(1)]
    })
  }
  for (const player of active_connections.values()) {
    player.ws.send(JSON.stringify(message))
  }
}

function set_player_timeout(player) {
  if (player.timeout !== null) {
    clearTimeout(player.timeout)
  }
  player.timeout = setTimeout(() => {
    console.log("Timing out")
    console.log(`Player ${player.name} timed out`)
    player.ws.close()
  }, PlayerTimeoutMs)
}

function get_next_id() {
  var value = running_id++
  if (running_id > 999) {
    running_id = 1
  }
  return value
}

wss.on('connection', function connection(ws) {
  var new_player_id = get_next_id()
  var player_name = "Anon_" + new_player_id
  const player = new Player(ws, new_player_id, player_name)
  active_connections.set(ws, player)
  set_player_timeout(player)

  ws.on('message', function message(data) {
    var handled = false
    set_player_timeout(player)
    try {
      const json_data = JSON.parse(data)
      const message_type = json_data.type
      if (message_type == 'join_room') {
        handled = join_custom_room(ws, json_data)
      } else if (message_type == "observe_room") {
        handled = observe_room(ws, json_data)
      } else if (message_type == "join_matchmaking") {
        handled = join_matchmaking(ws, json_data)
      } else if (message_type == "set_name") {
        set_name(player, json_data)
        handled = true
      } else if (message_type == "leave_room") {
        leave_room(player, false)
        handled = true
      } else if (message_type == "observe_room") {
        handled = observe_room(player, json_data)
      } else if (message_type == "game_message") {
        if (player.room !== null) {
          player.room.handle_game_message(player, json_data)
        }
        handled = true
      }
    }
    catch (e) {
      console.log(e)
    }
    if (!handled) {
      console.log('received: %s', data)
      ws.send('I got your: ' + data)
    }
  })

  ws.on('close', () => {
    handle_disconnect(ws)
  })

  const message = {
    type: 'server_hello',
    player_name: player_name
  }
  ws.send(JSON.stringify(message))
  broadcast_players_update()
})

console.log("Server started on port " + port + ".")