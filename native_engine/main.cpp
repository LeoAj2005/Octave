#include <luna-service2/lunaservice.h>
#include <gst/gst.h>
#include <glib.h>
#include <string>
#include <pbnjson.hpp>

static GstElement *pipeline = nullptr;
static GMainLoop  *main_loop = nullptr;
static bool eos_reached = false;
static guint bus_watch_id = 0;

void reset_pipeline()
{
    if (pipeline) {
        gst_element_set_state(pipeline, GST_STATE_NULL);
        gst_object_unref(pipeline);
        pipeline = nullptr;
    }
    eos_reached = false;
}

// GStreamer bus callback – sets EOS flag, handles errors
static gboolean bus_callback(GstBus *bus, GstMessage *msg, gpointer user_data)
{
    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_EOS:
            g_print("End of stream reached.\n");
            eos_reached = true;
            break;
        case GST_MESSAGE_ERROR: {
            GError *err = nullptr;
            gchar *debug_info = nullptr;
            gst_message_parse_error(msg, &err, &debug_info);
            g_printerr("GStreamer error: %s\n", err->message);
            g_error_free(err);
            g_free(debug_info);
            gst_element_set_state(pipeline, GST_STATE_NULL);
            break;
        }
        default:
            break;
    }
    return TRUE;
}

// Build pipeline programmatically – no string injection possible
GstElement* build_pipeline_from_uri(const std::string &uri)
{
    GstElement *pipeline = gst_pipeline_new("playback");
    GstElement *src = nullptr;

    if (uri.compare(0, 7, "http://") == 0 || uri.compare(0, 8, "https://") == 0) {
        src = gst_element_factory_make("souphttpsrc", "source");
        if (src) g_object_set(G_OBJECT(src), "location", uri.c_str(), nullptr);
    } else {
        std::string file_path = uri;
        if (file_path.compare(0, 7, "file://") == 0) {
            file_path = file_path.substr(7);
        }
        src = gst_element_factory_make("filesrc", "source");
        if (src) g_object_set(G_OBJECT(src), "location", file_path.c_str(), nullptr);
    }

    if (!src) {
        g_printerr("Failed to create source element for URI: %s\n", uri.c_str());
        gst_object_unref(pipeline);
        return nullptr;
    }

    GstElement *decode = gst_element_factory_make("decodebin", "decoder");
    GstElement *convert = gst_element_factory_make("audioconvert", "converter");
    GstElement *resample = gst_element_factory_make("audioresample", "resampler");
    GstElement *sink = gst_element_factory_make("pulsesink", "output");

    if (!decode || !convert || !resample || !sink) {
        g_printerr("Missing essential GStreamer elements.\n");
        gst_object_unref(pipeline);
        return nullptr;
    }

    gst_bin_add_many(GST_BIN(pipeline), src, decode, convert, resample, sink, nullptr);

    if (!gst_element_link(src, decode)) {
        g_printerr("Failed to link source to decodebin.\n");
        gst_object_unref(pipeline);
        return nullptr;
    }
    if (!gst_element_link_many(convert, resample, sink, nullptr)) {
        g_printerr("Failed to link converter chain.\n");
        gst_object_unref(pipeline);
        return nullptr;
    }

    // Dynamic pad from decodebin
    g_signal_connect(decode, "pad-added", G_CALLBACK(+[](GstElement *decodebin, GstPad *new_pad, gpointer user_data) {
        GstElement *convert = (GstElement *)user_data;
        GstPad *sink_pad = gst_element_get_static_pad(convert, "sink");
        if (gst_pad_is_linked(sink_pad)) {
            gst_object_unref(sink_pad);
            return;
        }
        GstPadLinkReturn ret = gst_pad_link(new_pad, sink_pad);
        if (GST_PAD_LINK_FAILED(ret)) {
            g_printerr("Failed to link decodebin pad to audioconvert.\n");
        }
        gst_object_unref(sink_pad);
    }), convert);

    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(pipeline));
    bus_watch_id = gst_bus_add_watch(bus, bus_callback, nullptr);
    gst_object_unref(bus);

    return pipeline;
}

// Luna service methods
bool play(LSHandle *sh, LSMessage *msg, void *ctx)
{
    const char *payload = LSMessageGetPayload(msg);
    if (!payload) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Invalid payload\"}", nullptr);
        return true;
    }

    pbnjson::JDomParser parser;
    if (!parser.parse(payload, pbnjson::JSchema::AllSchema())) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Invalid JSON\"}", nullptr);
        return true;
    }

    pbnjson::JValue root = parser.getDom();
    std::string uri;
    if (root.isObject() && root.hasKey("uri") && root["uri"].isString()) {
        uri = root["uri"].asString();
    } else {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Missing or invalid URI parameter\"}", nullptr);
        return true;
    }

    if (uri.empty()) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Empty URI\"}", nullptr);
        return true;
    }

    reset_pipeline();

    pipeline = build_pipeline_from_uri(uri);
    if (!pipeline) {
        pbnjson::JObject reply;
        reply.put("returnValue", false);
        reply.put("errorText", "Failed to create pipeline for URI");
        std::string replyStr = reply.stringify();
        LSMessageReply(sh, msg, replyStr.c_str(), nullptr);
        return true;
    }

    eos_reached = false;
    if (gst_element_set_state(pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        reset_pipeline();
        pbnjson::JObject reply;
        reply.put("returnValue", false);
        reply.put("errorText", "Failed to start playback");
        std::string replyStr = reply.stringify();
        LSMessageReply(sh, msg, replyStr.c_str(), nullptr);
        return true;
    }

    pbnjson::JObject reply;
    reply.put("returnValue", true);
    reply.put("status", "playing");
    std::string replyStr = reply.stringify();
    LSMessageReply(sh, msg, replyStr.c_str(), nullptr);
    return true;
}

bool pause_playback(LSHandle *sh, LSMessage *msg, void *ctx)
{
    if (pipeline) {
        gst_element_set_state(pipeline, GST_STATE_PAUSED);
        LSMessageReply(sh, msg, "{\"returnValue\":true, \"status\":\"paused\"}", nullptr);
    } else {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"No active pipeline\"}", nullptr);
    }
    return true;
}

bool resume_playback(LSHandle *sh, LSMessage *msg, void *ctx)
{
    if (pipeline) {
        gst_element_set_state(pipeline, GST_STATE_PLAYING);
        LSMessageReply(sh, msg, "{\"returnValue\":true, \"status\":\"playing\"}", nullptr);
    } else {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"No active pipeline\"}", nullptr);
    }
    return true;
}

bool stop_playback(LSHandle *sh, LSMessage *msg, void *ctx)
{
    reset_pipeline();
    LSMessageReply(sh, msg, "{\"returnValue\":true, \"status\":\"stopped\"}", nullptr);
    return true;
}

bool seek(LSHandle *sh, LSMessage *msg, void *ctx)
{
    if (!pipeline) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"No active pipeline\"}", nullptr);
        return true;
    }

    const char *payload = LSMessageGetPayload(msg);
    if (!payload) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Invalid payload\"}", nullptr);
        return true;
    }

    pbnjson::JDomParser parser;
    if (!parser.parse(payload, pbnjson::JSchema::AllSchema())) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Invalid JSON\"}", nullptr);
        return true;
    }

    pbnjson::JValue root = parser.getDom();
    if (!root.isObject() || !root.hasKey("position") || !root["position"].isNumber()) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Missing or invalid position parameter\"}", nullptr);
        return true;
    }

    double pos_sec = root["position"].asNumber<double>();
    gint64 pos_ns = static_cast<gint64>(pos_sec * GST_SECOND);

    if (!gst_element_seek_simple(pipeline, GST_FORMAT_TIME,
                                 static_cast<GstSeekFlags>(GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_KEY_UNIT),
                                 pos_ns)) {
        LSMessageReply(sh, msg, "{\"returnValue\":false, \"errorText\":\"Seek failed\"}", nullptr);
        return true;
    }

    LSMessageReply(sh, msg, "{\"returnValue\":true, \"status\":\"seeked\"}", nullptr);
    return true;
}

bool get_position(LSHandle *sh, LSMessage *msg, void *ctx)
{
    pbnjson::JObject reply;
    reply.put("returnValue", true);

    if (!pipeline) {
        reply.put("position", 0.0);
        reply.put("duration", 0.0);
        reply.put("ended", false);
    } else {
        gint64 pos = 0, dur = -1;
        if (gst_element_query_position(pipeline, GST_FORMAT_TIME, &pos)) {
            reply.put("position", pos / (double)GST_SECOND);
        } else {
            reply.put("position", 0.0);
        }
        if (gst_element_query_duration(pipeline, GST_FORMAT_TIME, &dur) && dur > 0) {
            reply.put("duration", dur / (double)GST_SECOND);
        } else {
            reply.put("duration", 0.0);
        }
        reply.put("ended", eos_reached);
    }

    std::string replyStr = reply.stringify();
    LSMessageReply(sh, msg, replyStr.c_str(), nullptr);
    return true;
}

int main(int argc, char *argv[])
{
    gst_init(&argc, &argv);
    main_loop = g_main_loop_new(nullptr, FALSE);

    LSError lerr;
    LSErrorInit(&lerr);
    LSHandle *handle = nullptr;

    if (!LSRegister("com.leoaj2005.octave.service", &handle, &lerr)) {
        g_printerr("Failed to register Luna service: %s\n", lerr.message);
        LSErrorFree(&lerr);
        return 1;
    }

    LSMethod methods[] = {
        { "play",         play },
        { "pause",        pause_playback },
        { "resume",       resume_playback },
        { "stop",         stop_playback },
        { "seek",         seek },
        { "getPosition",  get_position },
        { nullptr,        nullptr }
    };

    if (!LSRegisterCategory(handle, "/", methods, nullptr, nullptr, &lerr)) {
        g_printerr("Failed to register category: %s\n", lerr.message);
        LSErrorFree(&lerr);
        return 1;
    }

    if (!LSGmainAttach(handle, main_loop, &lerr)) {
        g_printerr("Failed to attach to main loop: %s\n", lerr.message);
        LSErrorFree(&lerr);
        return 1;
    }

    g_print("Octave native engine ready\n");
    g_main_loop_run(main_loop);

    reset_pipeline();
    if (bus_watch_id > 0) {
        g_source_remove(bus_watch_id);
    }
    g_main_loop_unref(main_loop);
    LSErrorFree(&lerr);

    return 0;
}