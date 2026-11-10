/******************************************************************************/
/** @file save_encode.cpp
 *     Encodes a struct into a record using its field table.
 */
/******************************************************************************/
#include "save_schema.h"
#include "save_internal.h"

#include <array>
#include <cstring>

#include <algorithm>
#include <unordered_map>
#include <vector>
/******************************************************************************/
/** Raw memory that is all zero reads the same in either byte order, so it needs no flag. */
static void note_raw_bytes(struct SaveBuffer *out, const uint8_t *bytes, uint32_t length)
{
    for (uint32_t index = 0; index < length; index++)
    {
        if (bytes[index] != 0)
        {
            out->has_raw_bytes = true;
            return;
        }
    }
}

static enum SaveResult encode_struct(struct SaveBuffer *out, const struct SaveStructDesc *desc, const uint8_t *src,
    enum SaveMode mode, struct SaveError *err, int depth);

/** The bytes of a union that its member in use doesn't cover. They are stored as they are in memory, and only
 *  when something is in them, so the bytes of a member that was picked wrongly are not lost. */
static enum SaveResult encode_member_tail(struct SaveBuffer *out, const struct SaveFieldDesc *field,
    const struct SaveStructDesc *member_table, const uint8_t *src, struct SaveError *err)
{
    const uint32_t region_end = field->offset + field->mem_size;
    uint32_t tail_start = save_struct_extent(member_table);
    tail_start = std::max(tail_start, field->offset);
    tail_start = std::min(tail_start, region_end);
    uint32_t tail_length = region_end - tail_start;
    bool has_bytes = false;
    for (uint32_t index = 0; (index < tail_length) && !has_bytes; index++)
        has_bytes = (src[tail_start + index] != 0);
    if (has_bytes && (tail_length > 0xFFFF))
        return save_fail(err, SVR_Unsupported, "%s: the bytes of a union past its member don't fit", field->name);
    if (!has_bytes)
        tail_length = 0;
    int failed = save_buf_u16(out, static_cast<uint16_t>(tail_length));
    if (tail_length > 0)
    {
        failed |= save_buf_u16(out, static_cast<uint16_t>(tail_start - field->offset));
        failed |= save_buf_append(out, src + tail_start, tail_length);
        out->has_raw_bytes = true;
    }
    return failed ? save_fail(err, SVR_NoMemory, "out of memory") : SVR_Ok;
}

static enum SaveResult encode_union(struct SaveBuffer *out, const struct SaveStructDesc *desc, const struct SaveFieldDesc *field,
    const uint8_t *src, enum SaveMode mode, struct SaveError *err, int depth)
{
    const struct SaveUnionDesc *union_desc = field->uni;
    int pick = -1;
    enum SaveResult result = save_union_pick(desc, field, src, &pick, err);
    if (result != SVR_Ok)
        return result;
    if ((pick >= 0) && (union_desc->members[pick].sub == nullptr) && (union_desc->members[pick].raw_size == 0))
        pick = -1;
    if (save_buf_u8(out, static_cast<uint8_t>(pick + 1)) != 0)
        return save_fail(err, SVR_NoMemory, "out of memory");
    if (pick < 0)
        return SVR_Ok;
    if (union_desc->members[pick].sub != nullptr)
    {
        result = encode_struct(out, union_desc->members[pick].sub, src, mode, err, depth + 1);
        if (result != SVR_Ok)
            return result;
        return encode_member_tail(out, field, union_desc->members[pick].sub, src, err);
    }
    note_raw_bytes(out, src + field->offset, union_desc->members[pick].raw_size);
    if (save_buf_append(out, src + field->offset, union_desc->members[pick].raw_size) != 0)
        return save_fail(err, SVR_NoMemory, "out of memory");
    return SVR_Ok;
}

/******************************************************************************/
/*
 * Most of a savegame is stored exactly as it is in memory: runs of fields that are numbers of their stored size,
 * one after the other with no gap (and structs made only of such fields). Each struct gets a plan once: such runs
 * are copied with one memcpy, the other fields (unions, booleans, numbers stored at another size, raw bytes) are
 * encoded one by one. This gives the same bytes as encoding every field in turn, many times faster for the big
 * arrays (things, creature controls, map tiles).
 */
namespace {

struct EncodeStep {
    bool run;               /* a run of fields stored as they are in memory */
    uint32_t field_index;   /* the field, when not a run */
    uint32_t offset;        /* the run's bytes */
    uint32_t length;
};

struct EncodePlan {
    std::vector<EncodeStep> steps;
    bool whole;             /* the whole struct, all its size, is one run */
};

const EncodePlan *encode_plan(const struct SaveStructDesc *desc, enum SaveMode mode, int depth);

/** Whether a field's bytes in memory are its stored bytes. */
bool field_stored_as_memory(const struct SaveFieldDesc *field, enum SaveMode mode, int depth)
{
    if ((field->flags & SVF_RAW) || (field->stored_type == SV_UNION) || !save_host_is_little_endian())
        return false;
    const uint32_t count = save_field_count(field);
    if ((count == 0) || (field->mem_size % count != 0))
        return false;
    const uint32_t elem = field->mem_size / count;
    if (field->stored_type == SV_STRUCT)
    {
        if ((field->sub == nullptr) || (field->sub->size != elem))
            return false;
        const EncodePlan *sub_plan = encode_plan(field->sub, mode, depth + 1);
        return (sub_plan != nullptr) && sub_plan->whole;
    }
    return save_fast_copy_ok(field->stored_type, elem);
}

const EncodePlan *encode_plan(const struct SaveStructDesc *desc, enum SaveMode mode, int depth)
{
    if (depth > SAVE_MAX_DEPTH)
        return nullptr;
    static std::unordered_map<const struct SaveStructDesc *, EncodePlan> plans[2];
    auto &known = plans[(mode == SVM_Save) ? 0 : 1];
    auto found = known.find(desc);
    if (found != known.end())
        return &found->second;
    EncodePlan plan;
    for (uint32_t field_index = 0; field_index < desc->field_count; field_index++)
    {
        const struct SaveFieldDesc *field = &desc->fields[field_index];
        if (!save_field_included(field, mode))
            continue;
        if (field_stored_as_memory(field, mode, depth))
        {
            if (!plan.steps.empty() && plan.steps.back().run
              && (plan.steps.back().offset + plan.steps.back().length == field->offset))
                plan.steps.back().length += field->mem_size;
            else
                plan.steps.push_back({true, 0, field->offset, field->mem_size});
        } else
        {
            plan.steps.push_back({false, field_index, 0, 0});
        }
    }
    plan.whole = (plan.steps.size() == 1) && plan.steps[0].run && (plan.steps[0].offset == 0)
        && (plan.steps[0].length == desc->size);
    return &known.emplace(desc, std::move(plan)).first->second;
}

} // namespace

/** Encodes one field, element by element. */
static enum SaveResult encode_field(struct SaveBuffer *out, const struct SaveStructDesc *desc, const struct SaveFieldDesc *field,
    const uint8_t *src, enum SaveMode mode, struct SaveError *err, int depth)
{
    const uint32_t count = save_field_count(field);
    const uint32_t elem = field->mem_size / count;
    const uint8_t *bytes = src + field->offset;
    if (field->flags & SVF_RAW)
        note_raw_bytes(out, bytes, field->mem_size);
    if (field->stored_type == SV_UNION)
        return encode_union(out, desc, field, src, mode, err, depth);
    if (field->stored_type == SV_STRUCT)
    {
        for (uint32_t index = 0; index < count; index++)
        {
            const enum SaveResult result = encode_struct(out, field->sub, bytes + (static_cast<size_t>(index) * elem), mode, err, depth + 1);
            if (result != SVR_Ok)
                return result;
        }
        return SVR_Ok;
    }
    if (save_fast_copy_ok(field->stored_type, elem))
    {
        if (save_buf_append(out, bytes, count * elem) != 0)
            return save_fail(err, SVR_NoMemory, "out of memory");
        return SVR_Ok;
    }
    const uint32_t stored_size = save_stored_size(field->stored_type);
    for (uint32_t index = 0; index < count; index++)
    {
        struct SaveValue value;
        std::array<uint8_t, 8> tmp;
        if (save_value_load_mem(bytes + (static_cast<size_t>(index) * elem), elem, field->stored_type, &value) != 0)
            return save_fail(err, SVR_Unsupported, "%s.%s: can't read a %u byte member as %s", desc->name, field->name,
                static_cast<unsigned>(elem), save_stored_name(field->stored_type));
        if (save_value_store_le(tmp.data(), field->stored_type, &value, (field->flags & SVF_CLAMP) != 0) < 0)
            return save_fail(err, SVR_Unsupported, "%s.%s: value doesn't fit %s", desc->name, field->name,
                save_stored_name(field->stored_type));
        if (save_buf_append(out, tmp.data(), stored_size) != 0)
            return save_fail(err, SVR_NoMemory, "out of memory");
    }
    return SVR_Ok;
}

static enum SaveResult encode_struct(struct SaveBuffer *out, const struct SaveStructDesc *desc, const uint8_t *src,
    enum SaveMode mode, struct SaveError *err, int depth)
{
    if (depth > SAVE_MAX_DEPTH)
        return save_fail(err, SVR_Unsupported, "%s: structs nest too deeply", desc->name);
    const EncodePlan *plan = encode_plan(desc, mode, depth);
    if (plan == nullptr)
        return save_fail(err, SVR_Unsupported, "%s: structs nest too deeply", desc->name);
    for (const EncodeStep &step : plan->steps)
    {
        if (step.run)
        {
            if (save_buf_append(out, src + step.offset, step.length) != 0)
                return save_fail(err, SVR_NoMemory, "out of memory");
            continue;
        }
        const enum SaveResult result = encode_field(out, desc, &desc->fields[step.field_index], src, mode, err, depth);
        if (result != SVR_Ok)
            return result;
    }
    return SVR_Ok;
}

enum SaveResult save_encode_record(struct SaveBuffer *out, const struct SaveStructDesc *desc, const void *src,
    enum SaveMode mode, struct SaveError *err)
{
    return encode_struct(out, desc, static_cast<const uint8_t *>(src), mode, err, 0);
}
