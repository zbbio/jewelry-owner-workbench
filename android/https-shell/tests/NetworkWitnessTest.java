package com.zbbio.jewelryassistant.n14;

import java.time.Instant;

public final class NetworkWitnessTest {
    private static int count;
    private static final String NO = "N15-UNIT4W1";
    private static final String B = "11223344";
    private static final Instant AT = Instant.parse("2026-01-01T00:00:03.000Z");

    private static void check(boolean result, String name) {
        ++count;
        if (!result) throw new AssertionError(name);
    }

    private static void reject(String stage, String no, String tail) {
        boolean rejected = false;
        try {
            NetworkWitness.validateLabels(stage, no, tail);
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        check(rejected, "labels must reject " + stage);
    }

    private static String row(String stage, String seconds, String tail) {
        return NetworkWitness.sampleJson(stage, Instant.parse("2026-01-01T00:00:" + seconds + ".000Z"),
            NO, NetworkWitness.classify(true, true, true, true, false, true, false, false), tail);
    }

    /** Canonical shared test output, solely a JVM fixture. */
    private static void fixture() {
        System.out.print("{\"schema\":\"n15-net-witness-v2\",\"fixtureOnly\":true,"
            + "\"provenance\":\"host_jvm_synthetic_only\",\"networkSamples\":[\n"
            + row("launch","03",null) + ",\n"
            + row("askA","09",null) + ",\n"
            + row("askB","19",null) + ",\n"
            + row("bVisible","28",B) + ",\n"
            + row("afterLateA","39",B) + ",\n"
            + row("noCard","46",null) + ",\n"
            + row("ownerReopen","59",null) + "\n],"
            + "\"syntheticTiming\":{\"launcherTapUtc\":\"2026-01-01T00:00:00.000Z\","
            + "\"askATapUtc\":\"2026-01-01T00:00:10.000Z\",\"askARequestAt\":\"2026-01-01T00:00:12.000Z\","
            + "\"askBTapUtc\":\"2026-01-01T00:00:20.000Z\",\"askBRequestAt\":\"2026-01-01T00:00:22.000Z\","
            + "\"bResponseUtc\":\"2026-01-01T00:00:25.000Z\",\"bVisibleUiUtc\":\"2026-01-01T00:00:27.000Z\","
            + "\"bRequestId\":\"12340000-0000-4000-8000-000011223344\","
            + "\"aReleasedUtc\":\"2026-01-01T00:00:36.000Z\",\"lateAUiUtc\":\"2026-01-01T00:00:40.000Z\","
            + "\"noCardTapUtc\":\"2026-01-01T00:00:47.000Z\",\"noCardRequestAt\":\"2026-01-01T00:00:48.000Z\","
            + "\"noCardUiUtc\":\"2026-01-01T00:00:51.000Z\",\"noCardRequestId\":\"12340000-0000-4000-8000-000055aa33cc\","
            + "\"noCardUiRequestTail\":\"55aa33cc\",\"ownerReopenTapUtc\":\"2026-01-01T00:00:57.000Z\"}}\n");
    }

    public static void main(String[] args) {
        if (args.length == 1 && "--fixture".equals(args[0])) {
            fixture();
            return;
        }
        NetworkWitness.Reading wifi = NetworkWitness.classify(true, true, true, true, false, true, false, false);
        check(wifi.type == NetworkWitness.Type.WIFI && wifi.validated && !wifi.vpnActive, "validated WIFI");
        NetworkWitness.Reading cell = NetworkWitness.classify(true, true, true, true, false, false, true, false);
        check(cell.type == NetworkWitness.Type.CELLULAR && cell.validated && !cell.vpnActive, "validated CELLULAR");
        NetworkWitness.Reading captive = NetworkWitness.classify(true, true, true, false, false, true, false, false);
        check(captive.type == NetworkWitness.Type.WIFI && !captive.validated, "captive WIFI stays unvalidated");
        NetworkWitness.Reading noInternet = NetworkWitness.classify(true, true, false, true, false, false, true, false);
        check(!noInternet.validated, "no internet capability");
        NetworkWitness.Reading vpn = NetworkWitness.classify(true, true, true, true, true, true, false, false);
        check(vpn.type == NetworkWitness.Type.OTHER && vpn.vpnActive, "VPN not WIFI");
        check(NetworkWitness.classify(true,true,true,true,false,true,true,false).type == NetworkWitness.Type.OTHER, "mixed");
        check(NetworkWitness.classify(true,true,true,true,false,true,false,true).type == NetworkWitness.Type.OTHER, "other transport");
        check(NetworkWitness.classify(true,true,true,true,false,false,false,true).type == NetworkWitness.Type.OTHER, "ethernet or USB");
        NetworkWitness.Reading none = NetworkWitness.classify(false, true, true, true, true, true, true, true);
        check(none.type == NetworkWitness.Type.NONE && !none.validated && !none.vpnActive, "no default");
        NetworkWitness.Reading race = NetworkWitness.classify(true,false,true,true,false,true,false,false);
        check(race.type == NetworkWitness.Type.OTHER && !race.validated, "capabilities raced");
        check(!NetworkWitness.unavailable().validated, "access not available");

        for (String s : NetworkWitness.STAGES) {
            String t = NetworkWitness.needsTail(s) ? B : null;
            String json = NetworkWitness.sampleJson(s,AT,NO,wifi,t);
            check(json.contains("\"stage\":\""+s+"\"") && json.contains("\"source\":\"android_connectivity_manager\""), "stage/source");
            check(json.contains("\"requestTail\":"+(t==null?"null":"\"11223344\"")), "tail stage shape");
            reject(s, NO, t == null ? B : null);
        }
        reject("rawPhysicalDisconnect", NO, null);
        reject("launch", "N15-aBBB", null);
        reject("launch", "N15-123", null);
        reject("launch", "N15-1234567890ABC", null);
        reject("launch", "N15-", null);
        reject("launch", " N15-ABCD", null);
        reject("launch", "N15-A\"BC", null);
        reject("bVisible", NO, "ABCDEF12");
        reject("bVisible", NO, "112233");
        reject("bVisible", NO, "12340000-0000-4000-8000-000011223344");
        check(NetworkWitness.sampleJson("launch",AT,NO,wifi,null).equals(
            "{\"stage\":\"launch\",\"utc\":\"2026-01-01T00:00:03.000Z\",\"source\":\"android_connectivity_manager\","
            + "\"testNo\":\"N15-UNIT4W1\",\"networkType\":\"WIFI\",\"validated\":true,\"vpnActive\":false,\"requestTail\":null}"),
            "literal field names and types; no device data");
        System.out.println("Network witness JVM assertions: " + count + " passed; no Android device/network");
    }
}
