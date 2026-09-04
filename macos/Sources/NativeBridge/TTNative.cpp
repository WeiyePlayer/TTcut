#include "TTNative.h"
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <cmath>
#include <string>
#include <memory>
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
#include <libavutil/opt.h>
}
static thread_local std::string lastError;
static int fail(const std::string &message, int code = 0) {
    char detail[AV_ERROR_MAX_STRING_SIZE] = {};
    if (code < 0) av_strerror(code, detail, sizeof(detail));
    lastError = message + (code < 0 ? std::string(": ") + detail : ""); return -1;
}
const char *tt_last_error() { return lastError.c_str(); }
struct TTReader {
    AVFormatContext *format = nullptr;
    AVCodecContext *codec = nullptr;
    AVPacket *packet = av_packet_alloc();
    AVFrame *frame = av_frame_alloc(), *filtered = av_frame_alloc();
    AVFilterGraph *graph = nullptr;
    AVFilterContext *input = nullptr, *output = nullptr;
    int stream = -1, rotation = 0, hdr = 0;
    bool eof = false;
    int64_t index = 0;
    double fps = 30, start = 0;
    cv::Mat pixels;
    ~TTReader() {
        avfilter_graph_free(&graph); av_frame_free(&filtered); av_frame_free(&frame);
        av_packet_free(&packet); avcodec_free_context(&codec); avformat_close_input(&format);
    }
};
TTReader *tt_reader_open(const char *path, int rotation, int hdr, double fps) {
    auto r = std::make_unique<TTReader>();
    av_log_set_level(AV_LOG_ERROR);
    int code = avformat_open_input(&r->format, path, nullptr, nullptr);
    if (code < 0) { fail("open video", code); return nullptr; }
    code = avformat_find_stream_info(r->format, nullptr);
    if (code < 0) { fail("read video streams", code); return nullptr; }
    const AVCodec *decoder = nullptr;
    r->stream = av_find_best_stream(r->format, AVMEDIA_TYPE_VIDEO, -1, -1, &decoder, 0);
    if (r->stream < 0) { fail("video stream missing"); return nullptr; }
    auto stream = r->format->streams[r->stream];
    r->codec = avcodec_alloc_context3(decoder);
    avcodec_parameters_to_context(r->codec, stream->codecpar);
    r->codec->thread_count = 2;
    code = avcodec_open2(r->codec, decoder, nullptr);
    if (code < 0) { fail("open decoder", code); return nullptr; }
    r->rotation = ((rotation % 360) + 360) % 360; r->hdr = hdr; r->fps = fps;
    r->start = stream->start_time == AV_NOPTS_VALUE ? 0 : stream->start_time * av_q2d(stream->time_base);
    return r.release();
}
static int createGraph(TTReader *r) {
    r->graph = avfilter_graph_alloc(); r->graph->nb_threads = 2;
    auto timebase = r->format->streams[r->stream]->time_base;
    std::string args = "video_size=" + std::to_string(r->frame->width) + "x" + std::to_string(r->frame->height)
        + ":pix_fmt=" + std::to_string(r->frame->format) + ":time_base=" + std::to_string(timebase.num) + "/" + std::to_string(timebase.den)
        + ":pixel_aspect=1/1";
    int code = avfilter_graph_create_filter(&r->input, avfilter_get_by_name("buffer"), "input", args.c_str(), nullptr, r->graph);
    if (code < 0) return fail("create decoder filter input", code);
    AVBufferSrcParameters *parameters = av_buffersrc_parameters_alloc();
    parameters->color_space = r->frame->colorspace;
    parameters->color_range = r->frame->color_range;
    code = av_buffersrc_parameters_set(r->input, parameters); av_free(parameters);
    if (code < 0) return fail("configure frame colorspace", code);
    code = avfilter_graph_create_filter(&r->output, avfilter_get_by_name("buffersink"), "output", nullptr, nullptr, r->graph);
    if (code < 0) return fail("create decoder filter output", code);
    // Tone mapping is confined to analysis/display pixels. Exports always read the original precision media.
    const char *chain = r->hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=full,format=bgr24" : "format=bgr24";
    AVFilterInOut *inputs = avfilter_inout_alloc(), *outputs = avfilter_inout_alloc();
    outputs->name = av_strdup("in"); outputs->filter_ctx = r->input; outputs->pad_idx = 0;
    inputs->name = av_strdup("out"); inputs->filter_ctx = r->output; inputs->pad_idx = 0;
    code = avfilter_graph_parse_ptr(r->graph, chain, &inputs, &outputs, nullptr);
    avfilter_inout_free(&inputs); avfilter_inout_free(&outputs);
    if (code < 0) return fail("parse decoder filter", code);
    code = avfilter_graph_config(r->graph, nullptr);
    return code < 0 ? fail("configure decoder filter", code) : 0;
}
int tt_reader_next(TTReader *r, TTFrame *out) {
    if (!r || !out) return fail("invalid decoder");
    try {
        while (true) {
            int code = avcodec_receive_frame(r->codec, r->frame);
            if (code == AVERROR_EOF) return 0;
            if (code == AVERROR(EAGAIN)) {
                if (r->eof) return fail("decoder stopped before EOF");
                while ((code = av_read_frame(r->format, r->packet)) >= 0) {
                    if (r->packet->stream_index != r->stream) { av_packet_unref(r->packet); continue; }
                    code = avcodec_send_packet(r->codec, r->packet); av_packet_unref(r->packet); break;
                }
                if (code == AVERROR_EOF) { r->eof = true; code = avcodec_send_packet(r->codec, nullptr); }
                if (code < 0) return fail("decode packet", code);
                continue;
            }
            if (code < 0) return fail("receive frame", code);
            if (!r->graph && createGraph(r) < 0) return -1;
            int64_t pts = r->frame->best_effort_timestamp;
            const double timestamp = pts == AV_NOPTS_VALUE ? r->index / r->fps : pts * av_q2d(r->format->streams[r->stream]->time_base) - r->start;
            code = av_buffersrc_add_frame_flags(r->input, r->frame, AV_BUFFERSRC_FLAG_KEEP_REF);
            if (code < 0) return fail("convert frame input", code);
            code = av_buffersink_get_frame(r->output, r->filtered);
            if (code < 0) return fail("convert frame output", code);
            cv::Mat raw(r->filtered->height, r->filtered->width, CV_8UC3, r->filtered->data[0], r->filtered->linesize[0]);
            if (r->rotation == 90) cv::rotate(raw, r->pixels, cv::ROTATE_90_CLOCKWISE);
            else if (r->rotation == 180) cv::rotate(raw, r->pixels, cv::ROTATE_180);
            else if (r->rotation == 270) cv::rotate(raw, r->pixels, cv::ROTATE_90_COUNTERCLOCKWISE);
            else raw.copyTo(r->pixels);
            av_frame_unref(r->filtered); av_frame_unref(r->frame);
            *out = {r->pixels.data, r->pixels.cols, r->pixels.rows, (int)r->pixels.step, r->index++, std::max(0.0, timestamp)};
            return 1;
        }
    } catch (const std::exception &e) { return fail(e.what()); }
}
int tt_reader_seek(TTReader *r, double seconds) {
    if (!r || !std::isfinite(seconds) || seconds < 0) return fail("invalid seek");
    auto stream = r->format->streams[r->stream];
    int64_t target = (int64_t)((seconds + r->start) / av_q2d(stream->time_base));
    int code = av_seek_frame(r->format, r->stream, target, AVSEEK_FLAG_BACKWARD);
    if (code < 0) return fail("seek video", code);
    avcodec_flush_buffers(r->codec); avfilter_graph_free(&r->graph); r->input = nullptr; r->output = nullptr; r->eof = false;
    r->index = (int64_t)std::llround(seconds * r->fps);
    return 0;
}
void tt_reader_close(TTReader *r) { delete r; }
static void normalize(const cv::Mat &pixels, float *out) {
    const float mean[] = {.485f, .456f, .406f}, std[] = {.229f, .224f, .225f};
    int count = pixels.cols * pixels.rows;
    for (int y = 0; y < pixels.rows; ++y) {
        const uint8_t *row = pixels.ptr(y);
        for (int x = 0; x < pixels.cols; ++x) for (int c = 0; c < 3; ++c)
            out[c * count + y * pixels.cols + x] = (row[x * 3 + c] / 255.0f - mean[c]) / std[c];
    }
}
static cv::Mat affine(int width, int height, int mw, int mh, bool inverse = false) {
    cv::Point2f c(width / 2.f, height / 2.f), d(mw / 2.f, mh / 2.f);
    float s = std::max(width, height) / 2.f, t = mw / 2.f;
    cv::Point2f src[3] = {c, {c.x, c.y-s}, {c.x-s, c.y-s}};
    cv::Point2f dst[3] = {d, {d.x, d.y-t}, {d.x-t, d.y-t}};
    return inverse ? cv::getAffineTransform(dst, src) : cv::getAffineTransform(src, dst);
}
int tt_prepare_blurball(const TTFrame *f, int x, int y, int w, int h, int mw, int mh, float *out) {
    try {
        cv::Mat frame(f->height, f->width, CV_8UC3, const_cast<uint8_t *>(f->bytes), f->stride), warped;
        cv::warpAffine(frame(cv::Rect(x,y,w,h)), warped, affine(w,h,mw,mh), cv::Size(mw,mh), cv::INTER_LINEAR);
        normalize(warped, out); return 0;
    } catch (const std::exception &e) { return fail(e.what()); }
}
int tt_prepare_table(const TTFrame *f, float *out) {
    try {
        cv::Mat frame(f->height, f->width, CV_8UC3, const_cast<uint8_t *>(f->bytes), f->stride), rgb, resized;
        cv::cvtColor(frame, rgb, cv::COLOR_BGR2RGB); cv::resize(rgb, resized, cv::Size(1600,896), 0,0,cv::INTER_LINEAR);
        normalize(resized, out); return 0;
    } catch (const std::exception &e) { return fail(e.what()); }
}
int tt_decode_heatmap(const float *data, int w, int h, float threshold, int rx, int ry, int rw, int rh, TTDetection *out, int capacity) {
    try {
        cv::Mat heat(h,w,CV_32F,const_cast<float *>(data)), mask, labels;
        if (!cv::checkRange(heat)) return 0;
        cv::compare(heat, threshold, mask, cv::CMP_GT);
        int count = cv::connectedComponents(mask, labels, 8), n = 0;
        std::vector<double> weights(count), xs(count), ys(count);
        for (int y=0;y<h;++y) for (int x=0;x<w;++x) {
            int l=labels.at<int>(y,x); if (!l) continue;
            double v=heat.at<float>(y,x); weights[l]+=v; xs[l]+=x*v; ys[l]+=y*v;
        }
        cv::Mat inverse=affine(rw,rh,w,h,true);
        for (int l=1;l<count;++l) {
            if (weights[l]<=0) continue;
            if (n>=capacity) return fail("heatmap component capacity exceeded");
            double x=xs[l]/weights[l], y=ys[l]/weights[l];
            out[n++]={inverse.at<double>(0,0)*x+inverse.at<double>(0,1)*y+inverse.at<double>(0,2)+rx,
                      inverse.at<double>(1,0)*x+inverse.at<double>(1,1)*y+inverse.at<double>(1,2)+ry, weights[l]};
        }
        return n;
    } catch (const std::exception &e) { return fail(e.what()); }
}
