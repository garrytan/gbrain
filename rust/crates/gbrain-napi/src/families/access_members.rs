//! Access members and groups: the member and group writes and the member, group and
//! pages-naming reads (rust/docs/store/access-members.md).

use gbrain_store::access_members::{AccessMemberInsert, AccessMemberLookup};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertAccessMember(spec)`: `{ groupsCreated }`.
    #[napi]
    pub fn insert_access_member<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: AccessMemberInsert = required(spec, "insertAccessMember spec")?;
            s.insert_access_member(&spec)
        })
    }

    /// `setAccessMemberDisabled(id, disabled)`.
    #[napi]
    pub fn set_access_member_disabled<'env>(
        &self,
        env: &'env Env,
        id: String,
        disabled: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_access_member_disabled(&id, disabled))
    }

    /// `setAccessMemberEmail(id, email)`: whether a member that is not removed changed.
    #[napi]
    pub fn set_access_member_email<'env>(
        &self,
        env: &'env Env,
        id: String,
        email: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_access_member_email(&id, email.as_deref())
        })
    }

    /// `setAccessMemberKind(id, kind)`.
    #[napi]
    pub fn set_access_member_kind<'env>(
        &self,
        env: &'env Env,
        id: String,
        kind: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_access_member_kind(&id, &kind))
    }

    /// `setAccessMemberLabelledOnly(id, labelledOnly)`.
    #[napi]
    pub fn set_access_member_labelled_only<'env>(
        &self,
        env: &'env Env,
        id: String,
        labelled_only: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_access_member_labelled_only(&id, labelled_only)
        })
    }

    /// `tombstoneAccessMember(id)`.
    #[napi]
    pub fn tombstone_access_member<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.tombstone_access_member(&id))
    }

    /// `addAccessGroupMembers(groupId, memberIds)`: whether the group was created.
    #[napi]
    pub fn add_access_group_members<'env>(
        &self,
        env: &'env Env,
        group_id: String,
        members: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.add_access_group_members(&group_id, &members)
        })
    }

    /// `removeAccessGroupMembers(groupId, memberIds)`.
    #[napi]
    pub fn remove_access_group_members<'env>(
        &self,
        env: &'env Env,
        group_id: String,
        members: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.remove_access_group_members(&group_id, &members)
        })
    }

    /// `deleteAccessGroup(id)`.
    #[napi]
    pub fn delete_access_group<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_access_group(&id))
    }

    /// `readAccessMembers(lookup)`: `AccessMemberRow[]`.
    #[napi]
    pub fn read_access_members<'env>(
        &self,
        env: &'env Env,
        lookup: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let lookup: AccessMemberLookup = required(lookup, "readAccessMembers lookup")?;
            s.read_access_members(&lookup)
        })
    }

    /// `readAccessGroups(id)`: `[{ id, members }]`.
    #[napi]
    pub fn read_access_groups<'env>(
        &self,
        env: &'env Env,
        id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_groups(id.as_deref()))
    }

    /// `listPagesNamingReader(principal, { live })`: `[{ slug, source_id }]`.
    #[napi]
    pub fn list_pages_naming_reader<'env>(
        &self,
        env: &'env Env,
        principal: String,
        live: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_pages_naming_reader(&principal, live))
    }
}
