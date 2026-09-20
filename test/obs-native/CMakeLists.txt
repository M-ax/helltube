cmake_minimum_required(VERSION 3.28)
project(helltube_obs_check LANGUAGES CXX)
set(OBS_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../../apps/obs-studio" CACHE PATH "Patched OBS source")
get_filename_component(OBS_SOURCE "${OBS_SOURCE}" ABSOLUTE)
set(OBS_BUILD "${OBS_SOURCE}/build_x64")
add_executable(helltube-obs-check main.cpp)
target_compile_features(helltube-obs-check PRIVATE cxx_std_17)
target_include_directories(helltube-obs-check PRIVATE "${OBS_SOURCE}/libobs" "${OBS_BUILD}/config"
  "${OBS_BUILD}/libobs" "${OBS_SOURCE}/.deps/obs-deps-2026-08-26-x64/include")
target_compile_definitions(helltube-obs-check PRIVATE HAVE_OBSCONFIG_H)
target_link_libraries(helltube-obs-check PRIVATE "${OBS_BUILD}/libobs/$<CONFIG>/obs.lib")
set_target_properties(helltube-obs-check PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${OBS_BUILD}/rundir/$<CONFIG>/bin/64bit")
