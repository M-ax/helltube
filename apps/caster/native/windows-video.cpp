// Windows capture runs independently of Chromium. Monitors use DXGI; windows
// use WGC with OS cursor embedding disabled. stdout carries bounded BGRX frames,
// stdin grants one frame at a time. No frame is recorded to disk.
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <dwmapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using winrt::com_ptr;
using winrt::check_hresult;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using Clock = std::chrono::steady_clock;

static std::string quote(const std::wstring& text) {
    std::string result = "\"";
    for (unsigned char c : winrt::to_string(text)) {
        if (c == '\\' || c == '"') { result += '\\'; result += c; }
        else if (c >= 32) result += c;
    }
    return result + '"';
}
static std::string base64(const uint8_t* bytes, size_t length) {
    const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output; output.reserve((length + 2) / 3 * 4);
    for (size_t i = 0; i < length; i += 3) {
        uint32_t n = uint32_t(bytes[i]) << 16;
        if (i + 1 < length) n |= uint32_t(bytes[i + 1]) << 8;
        if (i + 2 < length) n |= bytes[i + 2];
        output += alphabet[n >> 18]; output += alphabet[(n >> 12) & 63];
        output += i + 1 < length ? alphabet[(n >> 6) & 63] : '=';
        output += i + 2 < length ? alphabet[n & 63] : '=';
    }
    return output;
}
struct Bitmap {
    HDC dc = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ previous = nullptr;
    uint8_t* pixels = nullptr;
    int width = 0, height = 0;
    ~Bitmap() { reset(); }
    void reset() {
        if (dc && previous) SelectObject(dc, previous);
        if (bitmap) DeleteObject(bitmap);
        if (dc) DeleteDC(dc);
        dc = nullptr; bitmap = nullptr; previous = nullptr; pixels = nullptr;
    }
    void resize(int w, int h) {
        if (bitmap && w == width && h == height) return;
        reset(); width = w; height = h;
        BITMAPINFO info{};
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = w; info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        dc = CreateCompatibleDC(nullptr);
        bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, reinterpret_cast<void**>(&pixels), nullptr, 0);
        if (!dc || !bitmap) throw std::runtime_error("Could not allocate the capture image.");
        previous = SelectObject(dc, bitmap);
    }
};
struct Output {
    com_ptr<IDXGIAdapter1> adapter;
    com_ptr<IDXGIOutput1> output;
    DXGI_OUTPUT_DESC desc{};
};
static std::vector<Output> outputs() {
    com_ptr<IDXGIFactory1> factory;
    check_hresult(CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void()));
    std::vector<Output> result;
    for (UINT i = 0;; i++) {
        com_ptr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(i, adapter.put()) == DXGI_ERROR_NOT_FOUND) break;
        if (!adapter) continue;
        for (UINT j = 0;; j++) {
            com_ptr<IDXGIOutput> output;
            if (adapter->EnumOutputs(j, output.put()) == DXGI_ERROR_NOT_FOUND) break;
            if (!output) continue;
            DXGI_OUTPUT_DESC desc{}; check_hresult(output->GetDesc(&desc));
            if (desc.AttachedToDesktop) result.push_back({adapter, output.as<IDXGIOutput1>(), desc});
        }
    }
    return result;
}
static std::string thumbnail(const RECT& rect) {
    int sw = rect.right - rect.left, sh = rect.bottom - rect.top;
    if (sw <= 0 || sh <= 0) return "null";
    double scale = std::min(320.0 / sw, 180.0 / sh);
    Bitmap image; image.resize(std::max(1, int(sw * scale)), std::max(1, int(sh * scale)));
    HDC screen = GetDC(nullptr);
    SetStretchBltMode(image.dc, HALFTONE); SetBrushOrgEx(image.dc, 0, 0, nullptr);
    bool copied = StretchBlt(image.dc, 0, 0, image.width, image.height, screen,
        rect.left, rect.top, sw, sh, SRCCOPY | CAPTUREBLT);
    ReleaseDC(nullptr, screen); GdiFlush();
    if (!copied) return "null";
    size_t length = size_t(image.width) * image.height * 4;
    for (size_t i = 3; i < length; i += 4) image.pixels[i] = 255;
    return "{\"width\":" + std::to_string(image.width) + ",\"height\":" + std::to_string(image.height)
        + ",\"data\":\"" + base64(image.pixels, length) + "\"}";
}
static void listSources(bool windows) {
    std::cout << '[';
    bool first = true;
    if (windows) {
        EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
            auto& first = *reinterpret_cast<bool*>(parameter);
            if (!IsWindowVisible(window) || window == GetShellWindow()) return TRUE;
            DWORD cloaked = 0; DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
            if (cloaked || (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW)) return TRUE;
            wchar_t title[1024]{};
            if (!GetWindowTextW(window, title, 1024)) return TRUE;
            DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
            RECT rect{}; if (!GetWindowRect(window, &rect) || rect.right <= rect.left || rect.bottom <= rect.top) return TRUE;
            if (!first) std::cout << ','; first = false;
            std::string id = "native:window:" + std::to_string(reinterpret_cast<uintptr_t>(window)) + ":" + std::to_string(pid);
            std::cout << "{\"id\":\"" << id << "\",\"kind\":\"window\",\"handle\":\""
                << reinterpret_cast<uintptr_t>(window) << "\",\"pid\":" << pid << ",\"name\":" << quote(title)
                << ",\"width\":" << rect.right - rect.left << ",\"height\":" << rect.bottom - rect.top << '}';
            return TRUE;
        }, reinterpret_cast<LPARAM>(&first));
    } else {
        for (const auto& output : outputs()) {
            const auto& rect = output.desc.DesktopCoordinates;
            if (!first) std::cout << ','; first = false;
            std::wstring device = output.desc.DeviceName;
            std::wstring name = device + L" · " + std::to_wstring(rect.right - rect.left) + L" × " + std::to_wstring(rect.bottom - rect.top);
            std::cout << "{\"id\":" << quote(L"native:screen:" + device) << ",\"kind\":\"screen\",\"device\":" << quote(device)
                << ",\"name\":" << quote(name) << ",\"width\":" << rect.right - rect.left << ",\"height\":" << rect.bottom - rect.top
                << ",\"image\":" << thumbnail(rect) << '}';
        }
    }
    std::cout << "]\n";
}
struct Control {
    std::atomic<bool> running{true}, credit{false};
    HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    ~Control() { if (wake) CloseHandle(wake); }
};
class FramePacer {
    // Sleep(1..5) can round to 15.6 ms on Windows, turning a 30 fps target into
    // roughly 21 fps. A process-local high-resolution timer avoids changing
    // global timer settings or spinning on the CPU.
    HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
public:
    FramePacer() { if (!timer) throw std::runtime_error("Could not create the native capture frame timer."); }
    ~FramePacer() { CloseHandle(timer); }
    void until(Clock::time_point deadline) {
        auto remaining = std::chrono::duration_cast<std::chrono::microseconds>(deadline - Clock::now()).count();
        if (remaining <= 0) return;
        LARGE_INTEGER due{}; due.QuadPart = -remaining * 10;
        if (!SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE)) throw std::runtime_error("Could not pace native capture.");
        WaitForSingleObject(timer, INFINITE);
    }
};
static std::shared_ptr<Control> watchParent() {
    auto control = std::make_shared<Control>();
    std::thread([control] {
        char byte; DWORD read = 0;
        while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &read, nullptr) && read) {
            if (byte == 'n') { control->credit = true; SetEvent(control->wake); }
        }
        control->running = false; SetEvent(control->wake);
    }).detach();
    return control;
}
static bool writeBytes(const void* data, size_t size) {
    auto bytes = static_cast<const uint8_t*>(data);
    while (size) {
        DWORD written = 0;
        if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, DWORD(size), &written, nullptr) || !written) return false;
        bytes += written; size -= written;
    }
    return true;
}
struct Options {
    int width = 1280, height = 720, fps = 30;
    double x = 0, y = 0, w = 1, h = 1;
    bool cursor = true;
};
// All scaling, cropping, and monitor rotation happen on the GPU. Only the
// bounded output image is mapped to CPU memory, supporting different GPUs in
// the helper and Electron without imposing a same-adapter shared-handle API.
class Renderer {
    com_ptr<ID3D11Device> device;
    com_ptr<ID3D11DeviceContext> context;
    com_ptr<ID3D11VertexShader> vertex;
    com_ptr<ID3D11PixelShader> pixel;
    com_ptr<ID3D11SamplerState> sampler;
    com_ptr<ID3D11Buffer> constants;
    com_ptr<ID3D11Texture2D> input, target, staging;
    com_ptr<ID3D11ShaderResourceView> inputView;
    com_ptr<ID3D11RenderTargetView> targetView;
    UINT inputWidth = 0, inputHeight = 0;
    DXGI_FORMAT inputFormat = DXGI_FORMAT_UNKNOWN;
public:
    Bitmap image;
    Renderer(com_ptr<ID3D11Device> dev, com_ptr<ID3D11DeviceContext> ctx) : device(dev), context(ctx) {
        const char* shader = R"(
            Texture2D source : register(t0); SamplerState sampling : register(s0);
            cbuffer Settings : register(b0) { float4 crop; float4 transform; };
            struct V { float4 p : SV_Position; float2 uv : TEXCOORD0; };
            V vs(uint id : SV_VertexID) {
                V o; o.uv = float2((id << 1) & 2, id & 2);
                o.p = float4(o.uv.x * 2 - 1, 1 - o.uv.y * 2, 0, 1); return o;
            }
            float4 ps(V i) : SV_Target {
                float2 uv = crop.xy + i.uv * crop.zw;
                // Filtering stays inside the crop, even when a one-pixel region
                // must be expanded to the minimum 2x2 video frame.
                uv = clamp(uv, crop.xy + transform.yz * .5, crop.xy + crop.zw - transform.yz * .5);
                if (transform.x == 2) uv = float2(uv.y, 1 - uv.x);
                else if (transform.x == 3) uv = 1 - uv;
                else if (transform.x == 4) uv = float2(1 - uv.y, uv.x);
                return float4(source.Sample(sampling, uv).rgb, 1);
            })";
        com_ptr<ID3DBlob> code, error;
        check_hresult(D3DCompile(shader, strlen(shader), nullptr, nullptr, nullptr, "vs", "vs_4_0", 0, 0, code.put(), error.put()));
        check_hresult(device->CreateVertexShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, vertex.put()));
        code = nullptr; error = nullptr;
        check_hresult(D3DCompile(shader, strlen(shader), nullptr, nullptr, nullptr, "ps", "ps_4_0", 0, 0, code.put(), error.put()));
        check_hresult(device->CreatePixelShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, pixel.put()));
        D3D11_SAMPLER_DESC sample{}; sample.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sample.AddressU = sample.AddressV = sample.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        sample.MaxLOD = D3D11_FLOAT32_MAX; check_hresult(device->CreateSamplerState(&sample, sampler.put()));
        D3D11_BUFFER_DESC buffer{}; buffer.ByteWidth = 32; buffer.Usage = D3D11_USAGE_DEFAULT;
        buffer.BindFlags = D3D11_BIND_CONSTANT_BUFFER; check_hresult(device->CreateBuffer(&buffer, nullptr, constants.put()));
    }
    void draw(ID3D11Texture2D* source, int width, int height, DXGI_MODE_ROTATION rotation,
              const Options& options, RECT bounds, HWND window, bool separateCursor) {
        if (source) {
        D3D11_TEXTURE2D_DESC desc{}; source->GetDesc(&desc);
        if (inputWidth != desc.Width || inputHeight != desc.Height || inputFormat != desc.Format) {
            inputView = nullptr; input = nullptr;
            inputWidth = desc.Width; inputHeight = desc.Height; inputFormat = desc.Format;
            desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            desc.CPUAccessFlags = 0; desc.MiscFlags = 0;
            check_hresult(device->CreateTexture2D(&desc, nullptr, input.put()));
            check_hresult(device->CreateShaderResourceView(input.get(), nullptr, inputView.put()));
        }
        context->CopyResource(input.get(), source);
        }
        int x = int(options.x * width), y = int(options.y * height);
        int cw = std::max(1, std::min(width - x, int(std::round(options.w * width))));
        int ch = std::max(1, std::min(height - y, int(std::round(options.h * height))));
        double scale = std::min({1.0, double(options.width) / cw, double(options.height) / ch});
        int ow = std::max(2, int(cw * scale) & ~1), oh = std::max(2, int(ch * scale) & ~1);
        if (!target || image.width != ow || image.height != oh) {
            targetView = nullptr; target = nullptr; staging = nullptr;
            D3D11_TEXTURE2D_DESC out{}; out.Width = ow; out.Height = oh;
            out.MipLevels = out.ArraySize = out.SampleDesc.Count = 1;
            out.Format = DXGI_FORMAT_B8G8R8A8_UNORM; out.BindFlags = D3D11_BIND_RENDER_TARGET;
            check_hresult(device->CreateTexture2D(&out, nullptr, target.put()));
            check_hresult(device->CreateRenderTargetView(target.get(), nullptr, targetView.put()));
            out.BindFlags = 0; out.Usage = D3D11_USAGE_STAGING; out.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            check_hresult(device->CreateTexture2D(&out, nullptr, staging.put()));
            image.resize(ow, oh);
        }
        float parameters[] = {float(x) / width, float(y) / height, float(cw) / width, float(ch) / height,
            float(rotation), 1.0f / width, 1.0f / height, 0};
        context->UpdateSubresource(constants.get(), 0, nullptr, parameters, 0, 0);
        D3D11_VIEWPORT viewport{0, 0, float(ow), float(oh), 0, 1};
        context->RSSetViewports(1, &viewport);
        ID3D11RenderTargetView* rtv = targetView.get(); context->OMSetRenderTargets(1, &rtv, nullptr);
        context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertex.get(), nullptr, 0); context->PSSetShader(pixel.get(), nullptr, 0);
        ID3D11ShaderResourceView* srv = inputView.get(); context->PSSetShaderResources(0, 1, &srv);
        ID3D11SamplerState* state = sampler.get(); context->PSSetSamplers(0, 1, &state);
        ID3D11Buffer* buffer = constants.get(); context->PSSetConstantBuffers(0, 1, &buffer);
        context->Draw(3, 0);
        srv = nullptr; context->PSSetShaderResources(0, 1, &srv);
        context->OMSetRenderTargets(0, nullptr, nullptr);
        context->CopyResource(staging.get(), target.get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
        for (int row = 0; row < oh; row++) memcpy(image.pixels + size_t(row) * ow * 4,
            static_cast<uint8_t*>(mapped.pData) + size_t(row) * mapped.RowPitch, size_t(ow) * 4);
        context->Unmap(staging.get(), 0);
        if (options.cursor && separateCursor) drawCursor(bounds, window, x, y, cw, ch);
    }
    void drawCursor(RECT bounds, HWND window, int x, int y, int cw, int ch) {
        CURSORINFO cursor{sizeof(CURSORINFO)};
        if (!GetCursorInfo(&cursor) || !(cursor.flags & CURSOR_SHOWING)) return;
        if (window && GetAncestor(WindowFromPoint(cursor.ptScreenPos), GA_ROOT) != window) return;
        if (!PtInRect(&bounds, cursor.ptScreenPos)) return;
        ICONINFO icon{}; if (!GetIconInfo(cursor.hCursor, &icon)) return;
        BITMAP info{}; GetObjectW(icon.hbmColor ? icon.hbmColor : icon.hbmMask, sizeof(info), &info);
        int ih = icon.hbmColor ? info.bmHeight : info.bmHeight / 2;
        double sx = double(image.width) / cw, sy = double(image.height) / ch;
        int px = int((cursor.ptScreenPos.x - bounds.left - x - int(icon.xHotspot)) * sx);
        int py = int((cursor.ptScreenPos.y - bounds.top - y - int(icon.yHotspot)) * sy);
        DrawIconEx(image.dc, px, py, cursor.hCursor, std::max(1, int(info.bmWidth * sx)),
            std::max(1, int(ih * sy)), 0, nullptr, DI_NORMAL);
        GdiFlush();
        if (icon.hbmColor) DeleteObject(icon.hbmColor);
        if (icon.hbmMask) DeleteObject(icon.hbmMask);
    }
};
static void createDevice(IDXGIAdapter* adapter, com_ptr<ID3D11Device>& device, com_ptr<ID3D11DeviceContext>& context) {
    check_hresult(D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
        nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
}
static bool sendFrame(Renderer& renderer, uint32_t sequence, Clock::time_point started) {
    uint32_t header[] = {0x31564348, uint32_t(renderer.image.width), uint32_t(renderer.image.height),
        uint32_t(renderer.image.width * renderer.image.height * 4), sequence, 0};
    uint64_t timestamp = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - started).count();
    return writeBytes(header, sizeof(header)) && writeBytes(&timestamp, sizeof(timestamp))
        && writeBytes(renderer.image.pixels, header[3]);
}
static void captureMonitor(const std::wstring& name, const Options& options) {
    auto available = outputs();
    auto selected = std::find_if(available.begin(), available.end(), [&](const Output& output) { return name == output.desc.DeviceName; });
    if (selected == available.end()) throw std::runtime_error("The selected monitor disconnected. Refresh capture sources.");
    com_ptr<ID3D11Device> device; com_ptr<ID3D11DeviceContext> context;
    createDevice(selected->adapter.get(), device, context);
    com_ptr<IDXGIOutputDuplication> duplication;
    HRESULT result = selected->output->DuplicateOutput(device.get(), duplication.put());
    if (FAILED(result)) throw std::runtime_error("DXGI capture is unavailable. Stop other capture apps or select Chromium compatibility.");
    DXGI_OUTDUPL_DESC desc{}; duplication->GetDesc(&desc);
    Renderer renderer(device, context);
    auto control = watchParent(); auto started = Clock::now(), next = started, lastFrame = started;
    FramePacer pacer;
    uint32_t sequence = 0; bool separateCursor = true;
    while (control->running) {
        if (!control->credit) { WaitForSingleObject(control->wake, 100); continue; }
        if (Clock::now() < next) { pacer.until(next); continue; }
        DXGI_OUTDUPL_FRAME_INFO info{}; com_ptr<IDXGIResource> resource;
        result = duplication->AcquireNextFrame(100, &info, resource.put());
        if (result == DXGI_ERROR_WAIT_TIMEOUT) {
            // New viewers/encoders need a frame even on a static desktop.
            if (sequence && Clock::now() - lastFrame >= std::chrono::milliseconds(500)) {
                const auto frameStarted = Clock::now();
                control->credit = false;
                if (!sendFrame(renderer, ++sequence, started)) break;
                lastFrame = Clock::now();
                next = frameStarted + std::chrono::microseconds(1000000 / options.fps);
            }
            continue;
        }
        if (FAILED(result)) throw std::runtime_error("The display mode or desktop changed. Restart preview to reconnect DXGI.");
        const auto frameStarted = Clock::now();
        try {
            auto texture = resource.as<ID3D11Texture2D>();
            if (info.LastMouseUpdateTime.QuadPart) separateCursor = info.PointerPosition.Visible != FALSE;
            const auto& bounds = selected->desc.DesktopCoordinates;
            renderer.draw(texture.get(), bounds.right - bounds.left, bounds.bottom - bounds.top,
                desc.Rotation, options, bounds, nullptr, separateCursor);
        } catch (...) { duplication->ReleaseFrame(); throw; }
        check_hresult(duplication->ReleaseFrame());
        control->credit = false;
        if (!sendFrame(renderer, ++sequence, started)) break;
        lastFrame = Clock::now();
        next = frameStarted + std::chrono::microseconds(1000000 / options.fps);
    }
}
static void captureWindow(HWND window, DWORD pid, const Options& options) {
    DWORD currentPid = 0; GetWindowThreadProcessId(window, &currentPid);
    if (!IsWindow(window) || currentPid != pid) throw std::runtime_error("The selected application window closed. Refresh sources.");
    if (!GraphicsCaptureSession::IsSupported()) throw std::runtime_error("Native window capture is not supported by this Windows installation.");
    if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled"))
        throw std::runtime_error("Native window capture needs Windows 10 version 2004 or newer.");
    auto available = outputs(); HMONITOR monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
    auto selected = std::find_if(available.begin(), available.end(), [&](const Output& output) { return output.desc.Monitor == monitor; });
    com_ptr<ID3D11Device> device; com_ptr<ID3D11DeviceContext> context;
    createDevice(selected == available.end() ? nullptr : selected->adapter.get(), device, context);
    com_ptr<IInspectable> inspectable;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), inspectable.put()));
    auto runtimeDevice = inspectable.as<IDirect3DDevice>();
    auto factory = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{nullptr};
    check_hresult(factory->CreateForWindow(window, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
    auto size = item.Size();
    auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(runtimeDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    auto session = pool.CreateCaptureSession(item);
    session.IsCursorCaptureEnabled(false); // Never opt Windows into cursor embedding.
    if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval"))
        session.MinUpdateInterval(std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(
            std::chrono::microseconds(1000000 / options.fps)));
    auto control = watchParent();
    auto closed = item.Closed([control](auto&&, auto&&) { control->running = false; SetEvent(control->wake); });
    auto arrived = pool.FrameArrived([control](auto&&, auto&&) { SetEvent(control->wake); });
    session.StartCapture();
    Renderer renderer(device, context);
    FramePacer pacer;
    auto started = Clock::now(), next = started, lastFrame = started; uint32_t sequence = 0;
    CURSORINFO previousCursor{}; bool cachedImage = false;
    while (control->running) {
        GetWindowThreadProcessId(window, &currentPid);
        if (!IsWindow(window) || currentPid != pid) break;
        if (!control->credit || IsIconic(window)) { WaitForSingleObject(control->wake, 100); continue; }
        if (Clock::now() < next) { pacer.until(next); continue; }
        auto frame = pool.TryGetNextFrame();
        CURSORINFO cursor{sizeof(CURSORINFO)}; GetCursorInfo(&cursor);
        bool cursorChanged = options.cursor && (cursor.hCursor != previousCursor.hCursor || cursor.flags != previousCursor.flags
            || cursor.ptScreenPos.x != previousCursor.ptScreenPos.x || cursor.ptScreenPos.y != previousCursor.ptScreenPos.y);
        if (!frame && (!cachedImage || (!cursorChanged && Clock::now() - lastFrame < std::chrono::milliseconds(500)))) {
            WaitForSingleObject(control->wake, 16); continue;
        }
        com_ptr<ID3D11Texture2D> texture;
        if (frame) {
            // Consume the newest of the bounded pool's frames after backpressure.
            if (auto newer = pool.TryGetNextFrame()) { frame.Close(); frame = std::move(newer); }
            auto current = frame.ContentSize();
            if (current.Width <= 0 || current.Height <= 0) { frame.Close(); continue; }
            if (current.Width != size.Width || current.Height != size.Height) {
                frame.Close(); size = current; cachedImage = false;
                pool.Recreate(runtimeDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size); continue;
            }
            check_hresult(frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>()
                ->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
        }
        const auto frameStarted = Clock::now();
        RECT bounds{}; GetWindowRect(window, &bounds);
        RECT extended{};
        if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &extended, sizeof(extended)))
            && extended.right - extended.left == size.Width && extended.bottom - extended.top == size.Height) bounds = extended;
        renderer.draw(texture.get(), size.Width, size.Height, DXGI_MODE_ROTATION_IDENTITY, options, bounds, window, true);
        cachedImage = true;
        if (frame) frame.Close();
        previousCursor = cursor; control->credit = false;
        if (!sendFrame(renderer, ++sequence, started)) break;
        lastFrame = Clock::now();
        next = frameStarted + std::chrono::microseconds(1000000 / options.fps);
    }
    item.Closed(closed); pool.FrameArrived(arrived); session.Close(); pool.Close();
}
int wmain(int argc, wchar_t** argv) {
    try {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        if (argc == 3 && std::wstring(argv[1]) == L"list") { listSources(std::wstring(argv[2]) == L"window"); return 0; }
        if (argc != 13 || std::wstring(argv[1]) != L"capture") throw std::runtime_error("Invalid video capture arguments.");
        Options options;
        options.width = std::clamp(std::stoi(argv[5]), 320, 1920) & ~1;
        options.height = std::clamp(std::stoi(argv[6]), 180, 1080) & ~1;
        options.fps = std::clamp(std::stoi(argv[7]), 10, 60);
        auto fraction = [](const wchar_t* value, double low, double high) {
            double number = std::stod(value);
            if (!std::isfinite(number)) throw std::runtime_error("Invalid capture region.");
            return std::clamp(number, low, high);
        };
        options.x = fraction(argv[8], 0, .99); options.y = fraction(argv[9], 0, .99);
        options.w = fraction(argv[10], .01, 1); options.h = fraction(argv[11], .01, 1);
        options.cursor = std::wstring(argv[12]) == L"1";
        if (std::wstring(argv[2]) == L"screen") captureMonitor(argv[3], options);
        else if (std::wstring(argv[2]) == L"window") captureWindow(
            reinterpret_cast<HWND>(std::stoull(argv[3])), DWORD(std::stoul(argv[4])), options);
        else throw std::runtime_error("Unknown native video source.");
        return 0;
    } catch (const winrt::hresult_error& error) {
        std::cerr << "Native capture failed (0x" << std::hex << uint32_t(error.code().value) << "): "
            << winrt::to_string(error.message()) << '\n';
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; }
    return 1;
}
