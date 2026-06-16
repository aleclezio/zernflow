"use client";

import { useState, useEffect, useCallback } from "react";
import { User, ArrowLeft } from "lucide-react";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactPanel } from "@/components/inbox/contact-panel";
import { createClient } from "@/lib/supabase/client";
import { withBasePath } from "@/lib/client-url";
import { cn } from "@/lib/utils";
import type { Database } from "@/lib/types/database";

type Conversation = Database["public"]["Tables"]["conversations"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"] | null;
};
type Message = Database["public"]["Tables"]["messages"]["Row"];

export function InboxView({
  conversations,
  workspaceId,
}: {
  conversations: Conversation[];
  workspaceId: string;
}) {
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showContactPanel, setShowContactPanel] = useState(true);

  // Keep selected conversation in sync when conversation list updates
  const handleSelect = useCallback((c: Conversation) => {
    setSelected(c);
    // On phones the thread opens full-screen first; the contact sheet is opt-in
    // (otherwise the default-open panel would cover the thread on select).
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setShowContactPanel(false);
    }
  }, []);

  // Load messages when a conversation is selected
  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }

    async function loadMessages() {
      setLoadingMessages(true);
      try {
        const res = await fetch(
          withBasePath(`/api/v1/messages?conversationId=${selected!.id}`)
        );
        if (res.ok) {
          const data = await res.json();
          setMessages(data ?? []);
        } else {
          console.error("Failed to load messages:", res.status);
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to load messages:", err);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }

      // Mark as read
      if (selected!.unread_count > 0) {
        const supabase = createClient();
        await supabase
          .from("conversations")
          .update({ unread_count: 0 })
          .eq("id", selected!.id);
      }
    }

    loadMessages();
  }, [selected?.id]);

  return (
    <div className="flex h-full">
      {/* Left panel: Conversation list. Full-width on phones, hidden once a
          conversation is open (the thread takes over); always w-80 on desktop. */}
      <div className={cn("w-full flex-shrink-0 md:w-80", selected ? "hidden md:block" : "block")}>
        <ConversationList
          conversations={conversations}
          workspaceId={workspaceId}
          selectedId={selected?.id ?? null}
          onSelect={handleSelect}
        />
      </div>

      {/* Center panel: Message thread. On phones it's full-screen and only shown
          once a conversation is selected; always visible on desktop. */}
      <div className={cn("min-h-0 flex-1 flex-col", selected ? "flex" : "hidden md:flex")}>
        {/* Mobile thread header: back to the list + open the contact sheet */}
        {selected && (
          <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1 md:hidden">
            <button
              onClick={() => setSelected(null)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label="Back to conversations"
            >
              <ArrowLeft className="h-4 w-4" />
              Conversations
            </button>
            {!showContactPanel && selected.contact_id && (
              <button
                onClick={() => setShowContactPanel(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                aria-label="Show contact info"
              >
                <User className="h-3.5 w-3.5" />
                Contact
              </button>
            )}
          </div>
        )}
        {/* Desktop contact-panel toggle (when the panel is hidden) */}
        {selected && !showContactPanel && (
          <div className="hidden shrink-0 justify-end border-b border-border px-2 py-1 md:flex">
            <button
              onClick={() => setShowContactPanel(true)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label="Show contact info"
            >
              <User className="h-3.5 w-3.5" />
              Contact info
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {loadingMessages && selected ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : (
            <MessageThread
              conversation={selected}
              messages={messages}
            />
          )}
        </div>
      </div>

      {/* Right panel: Contact info. In-flow w-80 on desktop; a full-screen sheet
          on phones (ContactPanel owns the responsive positioning). */}
      {showContactPanel && selected?.contact_id && (
        <ContactPanel
          contactId={selected.contact_id}
          conversationId={selected.id}
          workspaceId={workspaceId}
          onClose={() => setShowContactPanel(false)}
        />
      )}
    </div>
  );
}
