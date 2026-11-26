# Firebase setup for Android call notifications

Firebase Cloud Messaging (FCM) lets the Worker wake the Android app to ring for an incoming contact call, even when the app is closed or the phone is asleep. FCM is free. These steps need your Google account, so they can't be automated.

## 1. Create the project

1. Open the [Firebase console](https://console.firebase.google.com/) and sign in.
2. Select **Create a project** (or **Add project**). Name it `chatlingua`.
3. Google Analytics isn't needed, so you can turn it off. Then create the project.
4. Stay on the free **Spark** plan. FCM doesn't need the paid plan.

## 2. Register the Android app

1. In the project overview, select the **Android** icon to add an app.
2. Enter the package name `com.chatlingua.app.cloudflare`. This is the Cloudflare build, the one with the orange cloud icon.
   - Optional: if you also want notifications in the legacy app, add a second Android app with `com.chatlingua.app`.
3. Leave the nickname and the SHA-1 certificate empty, because FCM doesn't need them. Select **Register app**.
4. Download **`google-services.json`**.
5. Skip the remaining SDK steps. I'll make those changes in the code.

Put `google-services.json` at:

```
android/app/google-services.json
```

This file holds the project's public identifiers, not a secret. It's still best kept out of a public repository, so I'll add it to `.gitignore`.

## 3. Create the server key for the Worker

The Worker uses a service account to send messages through the FCM HTTP v1 API.

1. In the Firebase console, open **Project settings** (the gear icon), then **Service accounts**.
2. Select **Generate new private key**, then **Generate key**. A JSON file downloads.
3. **This file is a secret.** Don't commit it, email it, or paste it into chat.
4. Store it as a Worker secret from the repository folder:

   ```powershell
   Get-Content path\to\downloaded-key.json -Raw | npx --yes wrangler@4.167.0 secret put FCM_SERVICE_ACCOUNT
   ```

5. Delete the downloaded file afterwards, or move it somewhere safe outside the repository.

## 4. Check that the Cloud Messaging API is on

In **Project settings**, open **Cloud Messaging** and check that **Firebase Cloud Messaging API (V1)** shows **Enabled**. If it shows disabled, use the menu next to it to enable it in Google Cloud.

## 5. Tell Claude it's done

Say that `google-services.json` is in place and the `FCM_SERVICE_ACCOUNT` secret is set. The remaining work is in the code:

- Add the Firebase Messaging dependency and the Google services Gradle plugin to the Android build.
- Register each phone's FCM token with the contact profile.
- Send a high-priority FCM data message from the Worker when a contact call rings, and a cancel message when it stops.
- Show the full-screen incoming-call notification from the message, with Answer and Decline buttons.
