On each step, keep the user informed of the progress by displaying the output.

### 1. Requirements

- R8 Version: 9.3.7-dev or later

### 2. Generate proto

The report and files must be generated at `{project_root}/tmp/r8analysis`. If
the folder is not present, create it. For example:

    mkdir -p "$PWD/tmp/r8analysis"

### 3. Remove existing files

To make sure that this invocation doesn't source data from previous runs, remove
the intermediate files `keepruleradius.json` and `analysis_result.txt` and
remove the proto files in the `{project_root}/tmp/r8analysis` folder. Example
bash commands:

    # Remove the intermediate JSON and the directory containing protobuf files
    rm tmp/r8analysis/keepruleradius.json
    rm tmp/r8analysis/*.pb

    # Copy the previous result to history before deleting the analysis
    if [ -f tmp/r8analysis/analysis_result.txt ];
    then cat tmp/r8analysis/analysis_result.txt > tmp/r8analysis/history.txt &&
     rm tmp/r8analysis/analysis_result.txt; fi

### 4. Generate the Configuration Analyzer report

Run the R8 enabled build with the system property
"-Dcom.android.tools.r8.dumpkeepradiustodirectory=$PWD/tmp/r8analysis" to
generate Configuration Analyzer report

    ./gradlew assembleRelease \
    -Dcom.android.tools.r8.dumpkeepradiustodirectory=$PWD/tmp/r8analysis

### 5. Convert to JSON

To convert the generated protobuf files in `{project_root}/tmp/r8analysis` into
json, run the following script. The json must be generated in
`{project_root}/tmp/r8analysis`. Ensure `keep_radius_pb2.py` (from Step 10) is
in the same directory.

    import sys
    import os
    import glob
    from google.protobuf import json_format
    import keep_radius_pb2

    def convert_pb_to_json(input_pb_path, output_json_path):
        bundle = keep_radius_pb2.BlastRadiusContainer()

        try:
            with open(input_pb_path, "rb") as pb_file:
                binary_data = pb_file.read()
        except Exception as e:
            print(f"Error reading file {input_pb_path}: {e}", file=sys.stderr)
            return False

        try:
            bundle.ParseFromString(binary_data)
        except Exception as e:
            print(f"Error parsing protobuf: {e}", file=sys.stderr)
            return False

        try:
            json_string = json_format.MessageToJson(
                bundle,
                always_print_fields_with_no_presence=True,
                preserving_proto_field_name=True,
                indent=4
            )
            with open(output_json_path, "w", encoding="utf-8") as json_file:
                json_file.write(json_string)
            return True
        except Exception as e:
            print(f"Error writing JSON: {e}", file=sys.stderr)
            return False

    if __name__ == "__main__":
     input_pb = sys.argv[1] if len(sys.argv) > 1 else None
        if not input_pb:
            pb_files = glob.glob("tmp/r8analysis/*.pb")
            if not pb_files:
                print("Error: No .pb file found in tmp/r8analysis", file=sys.stderr)
                sys.exit(1)
            input_pb = sorted(pb_files)[-1] # Use the most recent one
        output_json = sys.argv[2] if len(sys.argv) > 2 else "tmp/r8analysis/keepruleradius.json"
        if not convert_pb_to_json(input_pb, output_json):
            sys.exit(1)

### 6. Analyze

Run the following analysis script on the generated JSON to get the impact of the
keep rules and sort it.

    import json, sys

    def analyze(path):
        try:
            with open(path, 'r') as f:
                d = json.load(f)
        except Exception as e:
            print(f"Error loading JSON: {e}")
            return

        # Build reference map
        c_map = {c.get('id'): set(c.get('constraints', [])) for c in d.get('keep_constraints_table', [])}
        r_map = {r.get('id'): c_map.get(r.get('constraints_id'), set()) for r in d.get('keep_rule_blast_radius_table', [])}

        tot_opt = tot_obf = tot_shr = tot_items = 0

        # Tally constraints across all kept items
        for tbl in ('kept_class_info_table', 'kept_field_info_table', 'kept_method_info_table'):
            for i in d.get(tbl, []):
                tot_items += 1
                kb = i.get('kept_by', [])
                if any('DONT_OPTIMIZE' in r_map.get(r, set()) for r in kb): tot_opt += 1
                if any('DONT_OBFUSCATE' in r_map.get(r, set()) for r in kb): tot_obf += 1
                if any('DONT_SHRINK' in r_map.get(r, set()) for r in kb): tot_shr += 1

        # Find denominator
        bi = d.get('build_info', {})
        live = sum(int(bi.get(k, 0)) for k in ('live_class_count', 'live_field_count', 'live_method_count'))
        denom = live if live > 0 else tot_items

        # Check for globals
        globals_src = [g.get('source', '').lower() for g in d.get('global_keep_rule_blast_radius_table', [])]
        def score(cnt, flag):
            if any(flag in src for src in globals_src): return 0.0
            return max(0.0, 100.0 - ((cnt / denom * 100) if denom > 0 else 0))

        result = [
            f"Optimization Score: {score(tot_opt, '-dontoptimize'):.2f}%",
            f"Obfuscation Score:  {score(tot_obf, '-dontobfuscate'):.2f}%",
            f"Shrinking Score:    {score(tot_shr, '-dontshrink'):.2f}%"
        ]
        for line in result:
            print(line)
        with open("tmp/r8analysis/analysis_result.txt", "w") as f:
            f.write("\n".join(result))

    if __name__ == "__main__":
        path = sys.argv[1] if len(sys.argv) > 1 else "tmp/r8analysis/keepruleradius.json"
        analyze(path)

Outputs `analysis_result.txt` containing scores and rule impacts.

### 7. Report impactful rules

Identify the keep rules with the highest impact and the subsumed rules using the
following script.

    import json, sys

    def report(path):
        try:
            with open(path, 'r') as f:
                data = json.load(f)
        except Exception as e:
            print(f"Error loading JSON: {e}")
            return

        # Calculate denominator for percentage
        bi = data.get('build_info', {})
        live = sum(int(bi.get(k, 0)) for k in ('live_class_count', 'live_field_count', 'live_method_count'))
        denom = live if live > 0 else sum(len(data.get(tbl, [])) for tbl in ('kept_class_info_table', 'kept_field_info_table', 'kept_method_info_table'))

        processed = []
        for r in data.get('keep_rule_blast_radius_table', []):
            br = r.get('blast_radius', {})
            c, f, m = len(br.get('class_blast_radius', [])), len(br.get('field_blast_radius', [])), len(br.get('method_blast_radius', []))
            impact = c + f + m
            if impact == 0:
                continue
            impact_pct = (impact / denom * 100) if denom > 0 else 0.0
            processed.append({
                'id': r.get('id'),
                'source': r.get('source'),
                'impact': impact,
                'impact_pct': f"{impact_pct:.2f}%",
                'classes': c,
                'fields': f,
                'methods': m,
                'subsumed_by': br.get('subsumed_by', [])
            })

        processed.sort(key=lambda x: x['impact'], reverse=True)

        # Output JSON for the agent to fetch and process
        print(json.dumps({
            "top_5_impact_keep_rules": [r for r in processed if not r['subsumed_by']][:5],
            "subsumed": [r for r in processed if r['subsumed_by']]
        }, indent=2))

    if __name__ == "__main__":
        report("tmp/r8analysis/keepruleradius.json")

Add this data to the `analysis_result.txt` with the top impactful rules and
subsumed rules.

### 8. Compare with previous report

If `{project_root}/tmp/r8analysis/history.txt` exists, use the following script
to compare the previous run. Use this to compare with the current values

### 9. Remove generated files

After the final report and analysis results are generated, remove the
intermediate files `keepruleradius.json` and `analysis_result.txt` and remove
the proto files in "{project_root}/tmp/r8analysis" folder

    rm tmp/r8analysis/keepruleradius.json
    rm tmp/r8analysis/*.pb

### 10. Protobuf Python bindings

The following script `keep_radius_pb2.py` is required by the conversion script
in Step 5.

    from google.protobuf import descriptor as _descriptor
    from google.protobuf import descriptor_pool as _descriptor_pool
    from google.protobuf import runtime_version as _runtime_version
    from google.protobuf import symbol_database as _symbol_database
    from google.protobuf.internal import builder as _builder
    _runtime_version.ValidateProtobufRuntimeVersion(
        _runtime_version.Domain.PUBLIC,
        6,
        33,
        4,
        '',
        'keep_radius.proto'
    )
    # @@protoc_insertion_point(imports)

    _sym_db = _symbol_database.Default()
    DESCRIPTOR = _descriptor_pool.Default().AddSerializedFile(b'\n\x11keep_radius.proto\x12&com.android.tools.r8.blastradius.proto\"\x9f\x02\n\x13KeepRuleBlastRadius\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x0e\n\x06source\x18\x02 \x01(\t\x12\x16\n\x0e\x63onstraints_id\x18\x03 \x01(\x05\x12\x46\n\x06origin\x18\x04 \x01(\x0b\x32\x36.com.android.tools.r8.blastradius.proto.TextFileOrigin\x12I\n\x0c\x62last_radius\x18\x05 \x01(\x0b\x32\x33.com.android.tools.r8.blastradius.proto.BlastRadius\x12\x41\n\x04tags\x18\x06 \x03(\x0e\x32\x33.com.android.tools.r8.blastradius.proto.KeepRuleTag\"w\n\x0b\x42lastRadius\x12\x13\n\x0bsubsumed_by\x18\x01 \x03(\x05\x12\x1a\n\x12\x63lass_blast_radius\x18\x02 \x03(\x05\x12\x1a\n\x12\x66ield_blast_radius\x18\x03 \x03(\x05\x12\x1b\n\x13method_blast_radius\x18\x04 \x03(\x05\"\x7f\n\x19GlobalKeepRuleBlastRadius\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x0e\n\x06source\x18\x02 \x01(\t\x12\x46\n\x06origin\x18\x03 \x01(\x0b\x32\x36.com.android.tools.r8.blastradius.proto.TextFileOrigin\"j\n\x0fKeepConstraints\x12\n\n\x02id\x18\x01 \x01(\x05\x12K\n\x0b\x63onstraints\x18\x02 \x03(\x0e\x32\x36.com.android.tools.r8.blastradius.proto.KeepConstraint\"`\n\rKeptClassInfo\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x1a\n\x12\x63lass_reference_id\x18\x02 \x01(\x05\x12\x16\n\x0e\x66ile_origin_id\x18\x03 \x01(\x05\x12\x0f\n\x07kept_by\x18\x04 \x03(\x05\"`\n\rKeptFieldInfo\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x1a\n\x12\x66ield_reference_id\x18\x02 \x01(\x05\x12\x16\n\x0e\x66ile_origin_id\x18\x03 \x01(\x05\x12\x0f\n\x07kept_by\x18\x04 \x03(\x05\"b\n\x0eKeptMethodInfo\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x1b\n\x13method_reference_id\x18\x02 \x01(\x05\x12\x16\n\x0e\x66ile_origin_id\x18\x03 \x01(\x05\x12\x0f\n\x07kept_by\x18\x04 \x03(\x05\"a\n\x0e\x46ieldReference\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x1a\n\x12\x63lass_reference_id\x18\x02 \x01(\x05\x12\x19\n\x11type_reference_id\x18\x03 \x01(\x05\x12\x0c\n\x04name\x18\x04 \x01(\t\"c\n\x0fMethodReference\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x1a\n\x12\x63lass_reference_id\x18\x02 \x01(\x05\x12\x1a\n\x12proto_reference_id\x18\x03 \x01(\x05\x12\x0c\n\x04name\x18\x04 \x01(\t\"K\n\x0eProtoReference\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x15\n\rparameters_id\x18\x02 \x01(\x05\x12\x16\n\x0ereturn_type_id\x18\x03 \x01(\x05\"4\n\rTypeReference\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x17\n\x0fjava_descriptor\x18\x02 \x01(\t\";\n\x11TypeReferenceList\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x1a\n\x12type_reference_ids\x18\x02 \x03(\x05\"\x9f\x01\n\nFileOrigin\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x10\n\x08\x66ilename\x18\x02 \x01(\t\x12Q\n\x10maven_coordinate\x18\x03 \x01(\x0b\x32\x37.com.android.tools.r8.blastradius.proto.MavenCoordinate\x12 \n\x18provided_by_build_system\x18\x04 \x01(\x08\"I\n\x14\x43lassFileInJarOrigin\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x16\n\x0e\x66ile_origin_id\x18\x02 \x01(\x05\x12\r\n\x05\x65ntry\x18\x03 \x01(\t\"T\n\x0eTextFileOrigin\x12\x16\n\x0e\x66ile_origin_id\x18\x01 \x01(\x05\x12\x13\n\x0bline_number\x18\x02 \x01(\x05\x12\x15\n\rcolumn_number\x18\x03 \x01(\x05\"U\n\x0fMavenCoordinate\x12\n\n\x02id\x18\x01 \x01(\x05\x12\x10\n\x08group_id\x18\x02 \x01(\t\x12\x13\n\x0b\x61rtifact_id\x18\x03 \x01(\t\x12\x0f\n\x07version\x18\x04 \x01(\t\"\x9a\x01\n\tBuildInfo\x12\x13\n\x0b\x63lass_count\x18\x01 \x01(\x05\x12\x13\n\x0b\x66ield_count\x18\x02 \x01(\x05\x12\x14\n\x0cmethod_count\x18\x03 \x01(\x05\x12\x18\n\x10live_class_count\x18\x04 \x01(\x05\x12\x18\n\x10live_field_count\x18\x05 \x01(\x05\x12\x19\n\x11live_method_count\x18\x06 \x01(\x05\"\xd5\n\n\x14\x42lastRadiusContainer\x12M\n\x11\x66ile_origin_table\x18\x01 \x03(\x0b\x32\x32.com.android.tools.r8.blastradius.proto.FileOrigin\x12\x64\n\x1e\x63lass_file_in_jar_origin_table\x18\x02 \x03(\x0b\x32<.com.android.tools.r8.blastradius.proto.ClassFileInJarOrigin\x12W\n\x16maven_coordinate_table\x18\x03 \x03(\x0b\x32\x37.com.android.tools.r8.blastradius.proto.MavenCoordinate\x12U\n\x15\x66ield_reference_table\x18\x04 \x03(\x0b\x32\x36.com.android.tools.r8.blastradius.proto.FieldReference\x12W\n\x16method_reference_table\x18\x05 \x03(\x0b\x32\x37.com.android.tools.r8.blastradius.proto.MethodReference\x12U\n\x15proto_reference_table\x18\x06 \x03(\x0b\x32\x36.com.android.tools.r8.blastradius.proto.ProtoReference\x12S\n\x14type_reference_table\x18\x07 \x03(\x0b\x32\x35.com.android.tools.r8.blastradius.proto.TypeReference\x12\\\n\x19type_reference_list_table\x18\x08 \x03(\x0b\x32\x39.com.android.tools.r8.blastradius.proto.TypeReferenceList\x12T\n\x15kept_class_info_table\x18\t \x03(\x0b\x32\x35.com.android.tools.r8.blastradius.proto.KeptClassInfo\x12T\n\x15kept_field_info_table\x18\n \x03(\x0b\x32\x35.com.android.tools.r8.blastradius.proto.KeptFieldInfo\x12V\n\x16kept_method_info_table\x18\x0b \x03(\x0b\x32\x36.com.android.tools.r8.blastradius.proto.KeptMethodInfo\x12W\n\x16keep_constraints_table\x18\x0c \x03(\x0b\x32\x37.com.android.tools.r8.blastradius.proto.KeepConstraints\x12\x61\n\x1ckeep_rule_blast_radius_table\x18\r \x03(\x0b\x32;.com.android.tools.r8.blastradius.proto.KeepRuleBlastRadius\x12n\n#global_keep_rule_blast_radius_table\x18\x0e \x03(\x0b\x32\x41.com.android.tools.r8.blastradius.proto.GlobalKeepRuleBlastRadius\x12\x45\n\nbuild_info\x18\x0f \x01(\x0b\x32\x31.com.android.tools.r8.blastradius.proto.BuildInfo*\x1f\n\x0bKeepRuleTag\x12\x10\n\x0cPACKAGE_WIDE\x10\x00*H\n\x0eKeepConstraint\x12\x12\n\x0e\x44ONT_OBFUSCATE\x10\x00\x12\x11\n\rDONT_OPTIMIZE\x10\x01\x12\x0f\n\x0b\x44ONT_SHRINK\x10\x02\x42\x45\n&com.android.tools.r8.blastradius.protoB\x19KeepRuleBlastRadiusProtosP\001\x62\x06proto3')

    _globals = globals()
    _builder.BuildMessageAndEnumDescriptors(DESCRIPTOR, _globals)
    _builder.BuildTopDescriptorsAndMessages(DESCRIPTOR, 'keep_radius_pb2', _globals)
    if not _descriptor._USE_C_DESCRIPTORS:
        _globals['DESCRIPTOR']._loaded_options = None
        _globals['DESCRIPTOR']._serialized_options = b'\n&com.android.tools.r8.blastradius.protoB\031KeepRuleBlastRadiusProtosP\001'
        _globals['_KEEPRULETAG']._serialized_start = 3332
        _globals['_KEEPRULETAG']._serialized_end = 3363
        _globals['_KEEPCONSTRAINT']._serialized_start = 3365
        _globals['_KEEPCONSTRAINT']._serialized_end = 3437
        _globals['_KEEPRULEBLASTRADIUS']._serialized_start = 62
        _globals['_KEEPRULEBLASTRADIUS']._serialized_end = 349
        _globals['_BLASTRADIUS']._serialized_start = 351
        _globals['_BLASTRADIUS']._serialized_end = 470
        _globals['_GLOBALKEEPRULEBLASTRADIUS']._serialized_start = 472
        _globals['_GLOBALKEEPRULEBLASTRADIUS']._serialized_end = 599
        _globals['_KEEPCONSTRAINTS']._serialized_start = 601
        _globals['_KEEPCONSTRAINTS']._serialized_end = 707
        _globals['_KEPTCLASSINFO']._serialized_start = 709
        _globals['_KEPTCLASSINFO']._serialized_end = 805
        _globals['_KEPTFIELDINFO']._serialized_start = 807
        _globals['_KEPTFIELDINFO']._serialized_end = 903
        _globals['_KEPTMETHODINFO']._serialized_start = 905
        _globals['_KEPTMETHODINFO']._serialized_end = 1003
        _globals['_FIELDREFERENCE']._serialized_start = 1005
        _globals['_FIELDREFERENCE']._serialized_end = 1102
        _globals['_METHODREFERENCE']._serialized_start = 1104
        _globals['_METHODREFERENCE']._serialized_end = 1203
        _globals['_PROTOREFERENCE']._serialized_start = 1205
        _globals['_PROTOREFERENCE']._serialized_end = 1280
        _globals['_TYPEREFERENCE']._serialized_start = 1282
        _globals['_TYPEREFERENCE']._serialized_end = 1334
        _globals['_TYPEREFERENCELIST']._serialized_start = 1336
        _globals['_TYPEREFERENCELIST']._serialized_end = 1395
        _globals['_FILEORIGIN']._serialized_start = 1398
        _globals['_FILEORIGIN']._serialized_end = 1557
        _globals['_CLASSFILEINJARORIGIN']._serialized_start = 1559
        _globals['_CLASSFILEINJARORIGIN']._serialized_end = 1632
        _globals['_TEXTFILEORIGIN']._serialized_start = 1634
        _globals['_TEXTFILEORIGIN']._serialized_end = 1718
        _globals['_MAVENCOORDINATE']._serialized_start = 1720
        _globals['_MAVENCOORDINATE']._serialized_end = 1805
        _globals['_BUILDINFO']._serialized_start = 1808
        _globals['_BUILDINFO']._serialized_end = 1962
        _globals['_BLASTRADIUSCONTAINER']._serialized_start = 1965
        _globals['_BLASTRADIUSCONTAINER']._serialized_end = 3330
    # @@protoc_insertion_point(module_scope)