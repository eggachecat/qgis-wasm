vcpkg_download_distfile(ARCHIVE
    URLS "https://www.riverbankcomputing.com/static/Downloads/QScintilla/${VERSION}/QScintilla_src-${VERSION}.tar.gz"
    FILENAME "QScintilla-${VERSION}.tar.gz"
    SHA512 19e2f9e0a14947501c575018df368d24eb7f8c74e74faa5246db36415bf28dc0beee507ed0e73107c02b36a99bbaf55f0ef3349f479d2332e1b92b2c4a32788a
)
vcpkg_extract_source_archive(SOURCE_PATH ARCHIVE "${ARCHIVE}" PATCHES runstyles-wasm32.patch)
file(COPY "${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt" DESTINATION "${SOURCE_PATH}")
vcpkg_cmake_configure(SOURCE_PATH "${SOURCE_PATH}")
vcpkg_cmake_install()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
