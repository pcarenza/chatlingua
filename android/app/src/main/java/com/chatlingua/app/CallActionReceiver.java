package com.chatlingua.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.webkit.CookieManager;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Handles Decline from the call notification without opening the app. */
public final class CallActionReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String room = intent.getStringExtra("room");
        CallNotifications.cancel(context);
        if (room == null || !room.matches("[a-f0-9]{36}")) return;
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                decline(room);
            } catch (Exception ignored) {
                // The ring expires on its own if the server cannot be reached.
            } finally {
                result.finish();
            }
        }).start();
    }

    private static void decline(String room) throws Exception {
        String origin = BuildConfig.CHATLINGUA_ORIGIN;
        String cookie = CookieManager.getInstance().getCookie(origin);
        if (cookie == null || cookie.isEmpty()) return;
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + "/api/contacts/decline").openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(new JSONObject().put("room", room).toString().getBytes(StandardCharsets.UTF_8));
            }
            connection.getResponseCode();
        } finally {
            connection.disconnect();
        }
    }
}
