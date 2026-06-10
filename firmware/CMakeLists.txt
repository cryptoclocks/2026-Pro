cmake_minimum_required(VERSION 3.16)

# WAMR ships an ESP-IDF component at build-scripts/esp-idf/wamr (component name: "wamr")
set(EXTRA_COMPONENT_DIRS
    ${CMAKE_CURRENT_LIST_DIR}/components/wasm_engine/wasm-micro-runtime/build-scripts/esp-idf)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(cryptoclock_pro)
