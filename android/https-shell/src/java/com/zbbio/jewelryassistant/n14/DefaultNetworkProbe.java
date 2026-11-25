package com.zbbio.jewelryassistant.n14;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;

/** Reads capabilities for the active default route only, never network/device identifiers. */
final class DefaultNetworkProbe {
    private DefaultNetworkProbe() {}

    static NetworkWitness.Reading read(Context context) {
        try {
            ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
            if (cm == null) return NetworkWitness.unavailable();
            Network active = cm.getActiveNetwork();
            if (active == null) {
                return NetworkWitness.classify(false, false, false, false, false, false, false, false);
            }
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            if (caps == null || !active.equals(cm.getActiveNetwork())) return NetworkWitness.unavailable();
            final int api = Build.VERSION.SDK_INT;
            // SDK 34 is the last audited transport set. Unknown future transports are not evidence of WIFI/CELLULAR.
            boolean other = api > 34 || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
                || (api >= 27 && caps.hasTransport(NetworkCapabilities.TRANSPORT_LOWPAN))
                || (api >= 31 && caps.hasTransport(NetworkCapabilities.TRANSPORT_USB))
                || (api >= 34 && caps.hasTransport(NetworkCapabilities.TRANSPORT_THREAD));
            boolean vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN);
            return NetworkWitness.classify(true, true,
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
                vpn,
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                other);
        } catch (RuntimeException | LinkageError unavailable) {
            // Do not serialize an exception, Network object, or any fallback identifiers.
            return NetworkWitness.unavailable();
        }
    }
}
