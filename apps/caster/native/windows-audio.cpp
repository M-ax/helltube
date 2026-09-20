// WASAPI process-loopback capture. stdout is exclusively 48 kHz stereo s16le;
// stderr reports READY or a bounded diagnostic. No recording files are created.
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <wrl.h>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <string>
#include <set>
#include <vector>
#include <thread>
#include <atomic>
#include <memory>
#include <stdexcept>

using Microsoft::WRL::ComPtr;
static void check(HRESULT hr) {
    if (FAILED(hr)) throw hr;
}
static std::string utf8(const std::wstring& value) {
    int count = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), nullptr, 0, nullptr, nullptr);
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), result.data(), count, nullptr, nullptr);
    return result;
}
static std::string json(const std::string& value) {
    std::string result = "\"";
    for (unsigned char c : value) {
        if (c == '\\' || c == '"') { result += '\\'; result += c; }
        else if (c >= 32) result += c;
    }
    return result + '"';
}
static void listApplications() {
    ComPtr<IMMDeviceEnumerator> devices;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)));
    ComPtr<IMMDeviceCollection> outputs;
    check(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &outputs));
    UINT count = 0; check(outputs->GetCount(&count));
    std::set<DWORD> seen;
    std::cout << '[';
    bool first = true;
    for (UINT i = 0; i < count; i++) {
        ComPtr<IMMDevice> output; if (FAILED(outputs->Item(i, &output))) continue;
        ComPtr<IAudioSessionManager2> manager;
        if (FAILED(output->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager))) continue;
        ComPtr<IAudioSessionEnumerator> sessions; if (FAILED(manager->GetSessionEnumerator(&sessions))) continue;
        int size = 0; sessions->GetCount(&size);
        for (int j = 0; j < size; j++) {
            ComPtr<IAudioSessionControl> session; if (FAILED(sessions->GetSession(j, &session))) continue;
            AudioSessionState state; if (FAILED(session->GetState(&state)) || state == AudioSessionStateExpired) continue;
            ComPtr<IAudioSessionControl2> control; if (FAILED(session.As(&control))) continue;
            DWORD pid = 0; if (FAILED(control->GetProcessId(&pid)) || !pid || !seen.insert(pid).second) continue;
            HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if (!process) continue;
            wchar_t filename[32768]; DWORD length = 32768;
            BOOL ok = QueryFullProcessImageNameW(process, 0, filename, &length);
            CloseHandle(process);
            if (!ok) continue;
            std::wstring label(filename, length);
            label = label.substr(label.find_last_of(L"\\/") + 1);
            if (!first) std::cout << ','; first = false;
            std::cout << "{\"id\":\"process:" << pid << "\",\"pid\":" << pid
                << ",\"kind\":\"application\",\"label\":" << json(utf8(label)) << '}';
        }
    }
    std::cout << "]\n";
}

class Activation final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
    IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
public:
    HANDLE completed = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    ~Activation() { CloseHandle(completed); }
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activated = E_FAIL;
        ComPtr<IUnknown> object;
        result = operation->GetActivateResult(&activated, &object);
        if (SUCCEEDED(result)) result = activated;
        if (SUCCEEDED(result)) result = object.As(&client);
        SetEvent(completed);
        return S_OK;
    }
};

static void capture(DWORD pid, bool exclude) {
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = exclude
        ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT variant{};
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(params);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    auto activation = Microsoft::WRL::Make<Activation>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, activation.Get(), &operation));
    if (WaitForSingleObject(activation->completed, 10000) != WAIT_OBJECT_0) throw E_ABORT;
    check(activation->result);
    auto client = activation->client;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2; format.nSamplesPerSec = 48000; format.wBitsPerSample = 16;
    format.nBlockAlign = 4; format.nAvgBytesPerSec = 192000;
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK |
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0, 0, &format, nullptr));
    HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!ready) throw E_OUTOFMEMORY;
    check(client->SetEventHandle(ready));
    ComPtr<IAudioCaptureClient> reader;
    check(client->GetService(IID_PPV_ARGS(&reader)));
    HANDLE target = exclude ? nullptr : OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!exclude && !target) { CloseHandle(ready); throw HRESULT_FROM_WIN32(GetLastError()); }
    _setmode(_fileno(stdout), _O_BINARY);
    check(client->Start());
    std::cerr << "READY\n" << std::flush;
    // Parent closes stdin on stop/crash. No orphan capture remains after Electron exits.
    auto stopped = std::make_shared<std::atomic<bool>>(false);
    std::thread input([stopped] { char byte; while (std::cin.get(byte)) {} *stopped = true; });
    input.detach();
    try {
        while (!*stopped) {
            if (target && WaitForSingleObject(target, 0) == WAIT_OBJECT_0) break;
            DWORD wait = WaitForSingleObject(ready, 100);
            if (wait == WAIT_TIMEOUT) continue;
            if (wait != WAIT_OBJECT_0) throw E_FAIL;
            UINT32 available = 0; check(reader->GetNextPacketSize(&available));
            while (available && !*stopped) {
                BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
                check(reader->GetBuffer(&data, &frames, &flags, nullptr, nullptr));
                const size_t bytes = size_t(frames) * format.nBlockAlign;
                std::vector<BYTE> silence;
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.resize(bytes); data = silence.data(); }
                std::cout.write(reinterpret_cast<const char*>(data), bytes);
                check(reader->ReleaseBuffer(frames));
                std::cout.flush();
                if (!std::cout) { *stopped = true; break; }
                check(reader->GetNextPacketSize(&available));
            }
        }
    } catch (...) {
        client->Stop(); CloseHandle(ready);
        if (target) CloseHandle(target);
        throw;
    }
    client->Stop(); CloseHandle(ready);
    if (target) CloseHandle(target);
}

int wmain(int argc, wchar_t** argv) {
    try {
        check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
        if (argc == 2 && std::wstring(argv[1]) == L"list") listApplications();
        else if (argc == 4 && std::wstring(argv[1]) == L"capture") {
            wchar_t* end = nullptr;
            unsigned long pid = wcstoul(argv[2], &end, 10);
            if (!pid || *end || (std::wstring(argv[3]) != L"include" && std::wstring(argv[3]) != L"exclude")) throw E_INVALIDARG;
            capture(pid, std::wstring(argv[3]) == L"exclude");
        } else throw E_INVALIDARG;
        CoUninitialize(); return 0;
    } catch (HRESULT hr) {
        std::cerr << "WASAPI capture failed (0x" << std::hex << hr << "). Requires Windows build 20348 or newer and an available audio device.\n";
        return 1;
    } catch (...) { std::cerr << "Native audio capture failed.\n"; return 1; }
}
