package com.chatlingua.app;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public final class ChatLinguaMessagingService extends FirebaseMessagingService {
    @Override public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String room = data.get("room");
        if (room == null || !room.matches("[a-f0-9]{36}")) return;
        try {
            if ("cancel".equals(data.get("type"))) {
                CallNotifications.cancelRoom(this, room);
            } else if ("ring".equals(data.get("type"))) {
                long remaining = Long.parseLong(data.get("expires")) - System.currentTimeMillis();
                if (remaining <= 0) return;
                String name = data.get("name") == null ? "Someone" : data.get("name");
                if (name.length() > 60) name = name.substring(0, 60);
                CallNotifications.ring(this, name, room, remaining);
            }
        } catch (RuntimeException ignored) {}
    }

    @Override public void onNewToken(String token) {
        FcmToken.store(this, token);
        MainActivity.tokenChanged(token);
    }
}
