#include "pre_inc.h"
#include "kfx/renderer/opengl/GLFunctions.h"
#include "bflib_basics.h"
#include "globals.h" // ERRORLOG
#include "post_inc.h"

#ifdef __EMSCRIPTEN__
// WebGL2 reports itself as "OpenGL ES 3.0", so glad stops at the GL 3.0
// function set. These later core functions are part of WebGL2 too; load them
// by hand so the GL 3.3 renderer finds them.
static void load_webgl2_extras(void* (*proc_loader)(const char* name))
{
#define KFX_LOAD_GL(name, type) \
    if (glad_##name == nullptr) glad_##name = (type)proc_loader(#name)
    KFX_LOAD_GL(glDrawArraysInstanced, PFNGLDRAWARRAYSINSTANCEDPROC);
    KFX_LOAD_GL(glDrawElementsInstanced, PFNGLDRAWELEMENTSINSTANCEDPROC);
    KFX_LOAD_GL(glVertexAttribDivisor, PFNGLVERTEXATTRIBDIVISORPROC);
    KFX_LOAD_GL(glCopyBufferSubData, PFNGLCOPYBUFFERSUBDATAPROC);
    KFX_LOAD_GL(glGetUniformBlockIndex, PFNGLGETUNIFORMBLOCKINDEXPROC);
    KFX_LOAD_GL(glUniformBlockBinding, PFNGLUNIFORMBLOCKBINDINGPROC);
    KFX_LOAD_GL(glGetUniformIndices, PFNGLGETUNIFORMINDICESPROC);
    KFX_LOAD_GL(glGetActiveUniformsiv, PFNGLGETACTIVEUNIFORMSIVPROC);
    KFX_LOAD_GL(glGetActiveUniformBlockiv, PFNGLGETACTIVEUNIFORMBLOCKIVPROC);
    KFX_LOAD_GL(glFenceSync, PFNGLFENCESYNCPROC);
    KFX_LOAD_GL(glDeleteSync, PFNGLDELETESYNCPROC);
    KFX_LOAD_GL(glClientWaitSync, PFNGLCLIENTWAITSYNCPROC);
    KFX_LOAD_GL(glWaitSync, PFNGLWAITSYNCPROC);
    KFX_LOAD_GL(glGetSynciv, PFNGLGETSYNCIVPROC);
    KFX_LOAD_GL(glGetInteger64v, PFNGLGETINTEGER64VPROC);
    KFX_LOAD_GL(glGenSamplers, PFNGLGENSAMPLERSPROC);
    KFX_LOAD_GL(glDeleteSamplers, PFNGLDELETESAMPLERSPROC);
    KFX_LOAD_GL(glBindSampler, PFNGLBINDSAMPLERPROC);
    KFX_LOAD_GL(glSamplerParameteri, PFNGLSAMPLERPARAMETERIPROC);
    KFX_LOAD_GL(glSamplerParameterf, PFNGLSAMPLERPARAMETERFPROC);
#undef KFX_LOAD_GL
}
#endif

bool GLFunctions_Load(void* (*proc_loader)(const char* name))
{
    if (proc_loader == nullptr || !gladLoadGLLoader((GLADloadproc)proc_loader))
    {
        ERRORLOG("GLFunctions_Load: gladLoadGLLoader failed");
        return false;
    }
#ifdef __EMSCRIPTEN__
    load_webgl2_extras(proc_loader);
#endif
    return true;
}
