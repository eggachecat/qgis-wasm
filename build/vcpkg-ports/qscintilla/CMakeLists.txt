# CMake build for QScintilla 2.14.x (replaces qscintilla.pro). Static library, Qt 6.
cmake_minimum_required(VERSION 3.21)
project(QScintilla LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
find_package(Qt6 QUIET COMPONENTS PrintSupport)

file(GLOB QSCI_SRCS CONFIGURE_DEPENDS src/*.cpp)
list(FILTER QSCI_SRCS EXCLUDE REGEX "MacPasteboardMime")
file(GLOB SCI_SRCS CONFIGURE_DEPENDS scintilla/src/*.cpp scintilla/lexlib/*.cpp scintilla/lexers/*.cpp)
file(GLOB QSCI_HDRS CONFIGURE_DEPENDS src/Qsci/*.h)
set(QSCI_MOC_HDRS ${QSCI_HDRS} src/SciClasses.h src/ScintillaQt.h src/ListBoxQt.h)

# QsciPrinter needs QPrinter, which Qt does not provide on WebAssembly/iOS
set(QSCI_HAVE_PRINTER OFF)
if(TARGET Qt6::PrintSupport AND QT_FEATURE_printer)
  set(QSCI_HAVE_PRINTER ON)
endif()
if(NOT QSCI_HAVE_PRINTER)
  list(FILTER QSCI_SRCS EXCLUDE REGEX "qsciprinter")
  list(FILTER QSCI_MOC_HDRS EXCLUDE REGEX "qsciprinter")
  list(FILTER QSCI_HDRS EXCLUDE REGEX "qsciprinter")
endif()
message(STATUS "QScintilla: printer support ${QSCI_HAVE_PRINTER}, ${CMAKE_SYSTEM_NAME}")

add_library(qscintilla2_qt6 STATIC ${QSCI_SRCS} ${SCI_SRCS} ${QSCI_MOC_HDRS})
target_include_directories(qscintilla2_qt6
  PRIVATE src scintilla/include scintilla/lexlib scintilla/src
  PUBLIC $<INSTALL_INTERFACE:include>)
target_compile_definitions(qscintilla2_qt6 PRIVATE SCINTILLA_QT SCI_LEXER INCLUDE_DEPRECATED_FEATURES)
target_link_libraries(qscintilla2_qt6 PUBLIC Qt6::Widgets Qt6::Gui Qt6::Core)
if(QSCI_HAVE_PRINTER)
  target_link_libraries(qscintilla2_qt6 PUBLIC Qt6::PrintSupport)
endif()

install(TARGETS qscintilla2_qt6 ARCHIVE DESTINATION lib LIBRARY DESTINATION lib)
install(FILES ${QSCI_HDRS} DESTINATION include/Qsci)
