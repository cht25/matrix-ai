import { redirect } from "next/navigation";

// New chats live at /chat — this alias keeps deep links working.
export default function NewChatAlias() {
  redirect("/chat");
}
