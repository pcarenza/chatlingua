package com.chatlingua.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/** Firebase token cache. Every call is a no-op when Firebase is not configured (legacy build). */
final class FcmToken {
    private FcmToken() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("chatlingua", Context.MODE_PRIVATE);
    }

    static String cached(Context context) {
        return prefs(context).getString("fcmToken", "");
    }

    static void store(Context context, String token) {
        prefs(context).edit().putString("fcmToken", token).apply();
    }

    interface Listener { void onToken(String token); }

    /** Fetches the current token, caches it and reports it. */
    static void fetch(Context context, Listener listener) {
        try {
            if (FirebaseApp.getApps(context).isEmpty()) return;
            Context app = context.getApplicationContext();
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
                if (token == null || token.isEmpty()) return;
                store(app, token);
                listener.onToken(token);
            });
        } catch (RuntimeException ignored) {}
    }
}
