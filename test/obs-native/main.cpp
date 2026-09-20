#include <obs.h>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

static void require(bool value, const char *message)
{
    if (!value) {
        std::cerr << message << std::endl;
        std::exit(1);
    }
}

int main()
{
    std::string line;
    std::getline(std::cin, line);
    obs_data_t *config = obs_data_create_from_json(line.c_str());
    require(config != nullptr, "Missing test configuration");
    require(obs_startup("en-US", nullptr, nullptr), "OBS startup failed");
    obs_audio_info audioInfo = {48000, SPEAKERS_STEREO};
    require(obs_reset_audio(&audioInfo), "OBS audio startup failed");
    obs_video_info videoInfo = {};
    videoInfo.graphics_module = "libobs-d3d11";
    videoInfo.fps_num = 30;
    videoInfo.fps_den = 1;
    videoInfo.base_width = videoInfo.output_width = 640;
    videoInfo.base_height = videoInfo.output_height = 360;
    videoInfo.output_format = VIDEO_FORMAT_NV12;
    videoInfo.gpu_conversion = true;
    videoInfo.colorspace = VIDEO_CS_709;
    videoInfo.range = VIDEO_RANGE_PARTIAL;
    videoInfo.scale_type = OBS_SCALE_BICUBIC;
    require(obs_reset_video(&videoInfo) == OBS_VIDEO_SUCCESS, "OBS video startup failed");
    for (const auto *name : {"obs-webrtc", "obs-x264", "obs-ffmpeg"}) {
        obs_module_t *module = nullptr;
        const auto binary = std::string("../../obs-plugins/64bit/") + name + ".dll";
        const auto data = std::string("../../data/obs-plugins/") + name;
        require(obs_open_module(&module, binary.c_str(), data.c_str()) == MODULE_SUCCESS, "OBS plugin load failed");
        require(obs_init_module(module), "OBS plugin init failed");
    }
    auto *service = obs_service_create("helltube_whip", "Helltube test", config, nullptr);
    require(service != nullptr, "Helltube destination is not registered");
    int bitrate = 0;
    obs_service_get_max_bitrate(service, &bitrate, nullptr);
    require(bitrate == 6000, "Incorrect video bitrate limit");
    obs_service_get_max_bitrate(service, nullptr, &bitrate);
    require(bitrate == 128, "Incorrect audio bitrate limit");
    auto *videoSettings = obs_data_create_from_json("{\"bitrate\":1500,\"preset\":\"veryfast\"}");
    auto *audioSettings = obs_data_create_from_json("{\"bitrate\":128}");
    obs_service_apply_encoder_settings(service, videoSettings, audioSettings);
    require(std::string(obs_data_get_string(videoSettings, "profile")) == "baseline", "H264 profile must be Baseline");
    auto *video = obs_video_encoder_create("obs_x264", "test video", videoSettings, nullptr);
    auto *audio = obs_audio_encoder_create("ffmpeg_opus", "test audio", audioSettings, 0, nullptr);
    require(video && audio, "OBS encoder creation failed");
    obs_encoder_set_video(video, obs_get_video());
    obs_encoder_set_audio(audio, obs_get_audio());
    auto *sourceSettings = obs_data_create();
    obs_data_set_string(sourceSettings, "local_file", obs_data_get_string(config, "fixture"));
    obs_data_set_bool(sourceSettings, "is_local_file", true);
    obs_data_set_bool(sourceSettings, "looping", true);
    auto *source = obs_source_create("ffmpeg_source", "test pattern", sourceSettings, nullptr);
    require(source != nullptr, "OBS fixture source failed");
    obs_set_output_source(0, source);
    auto *output = obs_output_create("whip_output", "Helltube test output", nullptr, nullptr);
    require(output != nullptr, "OBS WHIP output missing");
    obs_output_set_service(output, service);
    obs_output_set_video_encoder(output, video);
    obs_output_set_audio_encoder(output, audio, 0);
    require(obs_output_start(output), "OBS output failed to start");
    for (int i = 0; i < 200 && obs_output_get_total_bytes(output) < 10000; i++)
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    require(obs_output_get_total_bytes(output) >= 10000, obs_output_get_last_error(output));
    std::cout << "HELLTUBE_OBS_READY" << std::endl;
    std::getline(std::cin, line);
    obs_output_stop(output);
    for (int i = 0; i < 100 && obs_output_active(output); i++)
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    obs_output_release(output);
    obs_set_output_source(0, nullptr);
    obs_source_release(source);
    obs_encoder_release(video);
    obs_encoder_release(audio);
    obs_service_release(service);
    obs_data_release(sourceSettings);
    obs_data_release(videoSettings);
    obs_data_release(audioSettings);
    obs_data_release(config);
    obs_shutdown();
    return 0;
}
