cmake_minimum_required(VERSION 3.7)
project(octave_native CXX)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GST REQUIRED
    gstreamer-1.0
    gstreamer-audio-1.0
)
pkg_check_modules(LUNA REQUIRED luna-service2)
pkg_check_modules(PBNJSON REQUIRED pbnjson_c)

add_executable(octave_engine main.cpp)
target_include_directories(octave_engine PRIVATE
    ${GST_INCLUDE_DIRS}
    ${LUNA_INCLUDE_DIRS}
    ${PBNJSON_INCLUDE_DIRS}
)
target_link_directories(octave_engine PRIVATE
    ${GST_LIBRARY_DIRS}
    ${LUNA_LIBRARY_DIRS}
    ${PBNJSON_LIBRARY_DIRS}
)
target_link_libraries(octave_engine
    ${GST_LIBRARIES}
    ${LUNA_LIBRARIES}
    ${PBNJSON_LIBRARIES}
)

install(TARGETS octave_engine DESTINATION bin)