#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct TTReader TTReader;
typedef struct { const uint8_t *bytes; int width, height, stride; int64_t index; double time; } TTFrame;
typedef struct { double x, y, confidence; } TTDetection;
const char *tt_last_error(void);
TTReader *tt_reader_open(const char *path, int rotation, int hdr, double fps);
int tt_reader_next(TTReader *, TTFrame *);
int tt_reader_seek(TTReader *, double seconds);
void tt_reader_close(TTReader *);
int tt_prepare_blurball(const TTFrame *, int x, int y, int width, int height, int modelWidth, int modelHeight, float *output);
int tt_prepare_table(const TTFrame *, float *output);
int tt_decode_heatmap(const float *, int width, int height, float threshold, int roiX, int roiY, int roiWidth, int roiHeight, TTDetection *out, int capacity);
#ifdef __cplusplus
}
#endif
