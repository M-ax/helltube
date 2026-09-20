// Exercise the actual GPU shader without changing any physical monitor's mode.
#define wmain casterVideoMain
#include "windows-video.cpp"
#undef wmain

static void expect(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
int wmain() {
    try {
        com_ptr<ID3D11Device> device; com_ptr<ID3D11DeviceContext> context;
        createDevice(nullptr, device, context);
        const uint32_t red = 0xffff0000, green = 0xff00ff00, blue = 0xff0000ff, yellow = 0xffffff00;
        uint32_t pixels[32];
        for (int y = 0; y < 4; y++) for (int x = 0; x < 8; x++)
            pixels[y * 8 + x] = y < 2 ? (x < 4 ? red : green) : (x < 4 ? blue : yellow);
        D3D11_TEXTURE2D_DESC desc{}; desc.Width = 8; desc.Height = 4;
        desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1; desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        D3D11_SUBRESOURCE_DATA data{pixels, 32, 0};
        com_ptr<ID3D11Texture2D> texture; check_hresult(device->CreateTexture2D(&desc, &data, texture.put()));
        Renderer renderer(device, context); Options options; options.cursor = false;
        const uint32_t expected[][4] = {{red, green, blue, yellow}, {blue, red, yellow, green},
            {yellow, blue, green, red}, {green, yellow, red, blue}};
        for (int rotation = 1; rotation <= 4; rotation++) {
            int width = rotation % 2 ? 8 : 4, height = rotation % 2 ? 4 : 8;
            renderer.draw(texture.get(), width, height, DXGI_MODE_ROTATION(rotation), options, {}, nullptr, false);
            expect(renderer.image.width == width && renderer.image.height == height, "Rotation changed the output aspect ratio.");
            const auto* output = reinterpret_cast<uint32_t*>(renderer.image.pixels);
            uint32_t corners[] = {output[0], output[width - 1], output[(height - 1) * width], output[width * height - 1]};
            for (int i = 0; i < 4; i++) expect(corners[i] == expected[rotation - 1][i], "Monitor rotation has incorrect corner pixels.");
        }
        options.x = .5; options.w = .5; options.h = .5;
        renderer.draw(texture.get(), 8, 4, DXGI_MODE_ROTATION_IDENTITY, options, {}, nullptr, false);
        expect(renderer.image.width == 4 && renderer.image.height == 2, "Region output bounds are incorrect.");
        const auto* cropped = reinterpret_cast<uint32_t*>(renderer.image.pixels);
        for (int i = 0; i < 8; i++) expect(cropped[i] == green, "Region includes pixels outside the selected quadrant.");
        renderer.draw(nullptr, 8, 4, DXGI_MODE_ROTATION_IDENTITY, options, {}, nullptr, false);
        expect(reinterpret_cast<uint32_t*>(renderer.image.pixels)[0] == green, "Static frame refresh lost its source texture.");
        options.x = 3.0 / 8; options.y = 1.0 / 4; options.w = options.h = .01;
        renderer.draw(texture.get(), 8, 4, DXGI_MODE_ROTATION_IDENTITY, options, {}, nullptr, false);
        expect(renderer.image.width == 2 && renderer.image.height == 2, "Single-pixel region dimensions are invalid.");
        for (int i = 0; i < 4; i++) expect(reinterpret_cast<uint32_t*>(renderer.image.pixels)[i] == red,
            "Filtering a tiny region included neighboring pixels.");
        options = {}; options.width = 4; options.height = 2; options.cursor = false;
        renderer.draw(texture.get(), 8, 4, DXGI_MODE_ROTATION_IDENTITY, options, {}, nullptr, false);
        expect(renderer.image.width == 4 && renderer.image.height == 2, "GPU output scaling exceeded its bounds.");
        std::cout << "GPU rotation, region isolation, output bounds, and cached frame refresh passed.\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; }
      catch (const winrt::hresult_error& error) { std::cerr << winrt::to_string(error.message()) << '\n'; }
    return 1;
}
