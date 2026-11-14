import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const empty = { type: "object", properties: {} };
const appDir = path.dirname(fileURLToPath(import.meta.url));
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const required = (properties, keys) => ({ type: "object", properties, required: keys });

export const TOOL_DEFINITIONS = [
  ["whatsapp_status", "Get WhatsApp connection status.", empty],
  ["whatsapp_link_status", "Check whether WhatsApp is linked and ready.", empty],
  ["whatsapp_delink", "Log out and remove the saved WhatsApp session.", empty],
  ["whatsapp_list_chats", "List WhatsApp chats.", empty],
  ["whatsapp_get_chat_messages", "Get recent messages from a chat.", required({ chat_id: { type: "string" }, limit: { type: "integer" } }, ["chat_id"])],
  ["whatsapp_search_contacts", "Search WhatsApp contacts by name or number.", required({ query: { type: "string" } }, ["query"])],
  ["whatsapp_get_contact", "Get contact details.", required({ contact_id: { type: "string" } }, ["contact_id"])],
  ["whatsapp_send_message", "Send a WhatsApp text message.", required({ chat_id: { type: "string" }, message: { type: "string" } }, ["chat_id", "message"])],
  ["whatsapp_send_file", "Send a local file to a WhatsApp chat.", required({ chat_id: { type: "string" }, file_path: { type: "string" }, caption: { type: "string" } }, ["chat_id", "file_path"])],
  ["whatsapp_send_location", "Send a location pin.", required({ chat_id: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, description: { type: "string" } }, ["chat_id", "latitude", "longitude"])],
  ["whatsapp_mark_chat_read", "Mark a chat as read.", required({ chat_id: { type: "string" } }, ["chat_id"])],
  ["whatsapp_archive_chat", "Archive or unarchive a chat.", required({ chat_id: { type: "string" }, archive: { type: "boolean" } }, ["chat_id", "archive"])],
  ["whatsapp_mute_chat", "Mute or unmute a chat.", required({ chat_id: { type: "string" }, duration: { type: "string" } }, ["chat_id", "duration"])],
  ["whatsapp_get_unread_messages", "List chats with unread messages.", empty],
  ["whatsapp_get_group_info", "Get group metadata and participants.", required({ group_id: { type: "string" } }, ["group_id"])],
  ["whatsapp_add_group_member", "Add a participant to a group.", required({ group_id: { type: "string" }, contact_id: { type: "string" } }, ["group_id", "contact_id"])],
  ["whatsapp_remove_group_member", "Remove a participant from a group.", required({ group_id: { type: "string" }, contact_id: { type: "string" } }, ["group_id", "contact_id"])],
  ["whatsapp_leave_group", "Leave a WhatsApp group.", required({ group_id: { type: "string" } }, ["group_id"])]
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

const id = (value) => String(value || "").includes("@") ? String(value) : `${String(value || "").replace(/\D/g, "")}@c.us`;
const chat = async (client, value) => client.getChatById(String(value));

export async function executeWhatsAppTool(name, args = {}, client, state) {
  try {
    const status = JSON.parse(fsSync.readFileSync(path.join(appDir, ".mcp-status.json"), "utf8"));
    if (status.state) state = status.state;
  } catch {}
  if (name === "whatsapp_status" || name === "whatsapp_link_status") return text({ state, ready: state === "ready", qr_required: state === "qr_required" });
  if (name === "whatsapp_delink") {
    try { await Promise.race([client?.destroy(), new Promise((resolve) => setTimeout(resolve, 5000))]); } catch {}
    try { await fs.rm(path.join(appDir, ".wwebjs_auth"), { recursive: true, force: true }); } catch {}
    return text("WhatsApp was delinked. Start the server to create a new QR code.");
  }
  if (state !== "ready") return text(`WhatsApp is not ready. Current state: ${state}`);
  if (name === "whatsapp_list_chats") return text((await client.getChats()).slice(0, 100).map(c => ({ id: c.id._serialized, name: c.name, is_group: c.isGroup, unread: c.unreadCount })));
  if (name === "whatsapp_get_chat_messages") return text(await (await chat(client, args.chat_id)).fetchMessages({ limit: args.limit || 30 }));
  if (name === "whatsapp_search_contacts") return text((await client.getContacts()).filter(c => `${c.name} ${c.pushname} ${c.number}`.toLowerCase().includes(String(args.query).toLowerCase())).slice(0, 50));
  if (name === "whatsapp_get_contact") return text(await client.getContactById(String(args.contact_id)));
  if (name === "whatsapp_send_message") { await client.sendMessage(id(args.chat_id), args.message); return text("Message sent."); }
  if (name === "whatsapp_send_file") {
    const filePath = String(args.file_path || "").trim();
    if (!filePath) return text("File path is required.");
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    let fileInfo;
    try { fileInfo = await fs.stat(resolvedPath); } catch { return text(`File not found: ${resolvedPath}`); }
    if (!fileInfo.isFile()) return text(`Not a regular file: ${resolvedPath}`);
    try {
      const whatsappWeb = (await import("../node_modules/whatsapp-web.js/index.js")).default;
      const MessageMedia = whatsappWeb?.MessageMedia;
      if (!MessageMedia?.fromFilePath) return text("File send failed: WhatsApp media support is unavailable.");
      const media = MessageMedia.fromFilePath(resolvedPath);
      await client.sendMessage(id(args.chat_id), media, { caption: String(args.caption || "") });
      return text(`File sent: ${path.basename(resolvedPath)}`);
    } catch (error) {
      return text(`File send failed: ${error?.message || String(error)}`);
    }
  }
  if (name === "whatsapp_send_location") { const { Location } = await import("../node_modules/whatsapp-web.js/index.js"); await client.sendMessage(id(args.chat_id), new Location(args.latitude, args.longitude, args.description || "")); return text("Location sent."); }
  if (name === "whatsapp_mark_chat_read") { await (await chat(client, args.chat_id)).sendSeen(); return text("Chat marked as read."); }
  if (name === "whatsapp_archive_chat") { await (await chat(client, args.chat_id)).archive(args.archive); return text(args.archive ? "Chat archived." : "Chat unarchived."); }
  if (name === "whatsapp_mute_chat") {
    const duration = String(args.duration || "86400").toLowerCase();
    const seconds = duration === "unmute" || duration === "0" ? 0 : Number(duration) || 86400;
    const until = seconds === 0 ? new Date(0) : new Date(Date.now() + seconds * 1000);
    await (await chat(client, args.chat_id)).mute(until);
    return text(seconds === 0 ? "Chat unmuted." : "Chat muted.");
  }
  if (name === "whatsapp_get_unread_messages") return text((await client.getChats()).filter(c => c.unreadCount > 0).map(c => ({ id: c.id._serialized, name: c.name, unread: c.unreadCount })));
  if (name === "whatsapp_get_group_info") return text(await client.getChatById(String(args.group_id)));
  if (name === "whatsapp_add_group_member") { await (await chat(client, args.group_id)).addParticipants([id(args.contact_id)]); return text("Participant added."); }
  if (name === "whatsapp_remove_group_member") { await (await chat(client, args.group_id)).removeParticipants([id(args.contact_id)]); return text("Participant removed."); }
  if (name === "whatsapp_leave_group") { await (await chat(client, args.group_id)).leave(); return text("Left the group."); }
  return text(`Unknown WhatsApp tool: ${name}`);
}
