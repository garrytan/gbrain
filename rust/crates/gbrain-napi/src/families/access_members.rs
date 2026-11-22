//! Access members and groups.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/docs/store/access-members.md). Timestamps leave as ISO strings and
//! the shell makes them `Date`s.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertAccessMember({ id, displayName?, email?, kind?, groups?, bindTokenId? })`: `{ groupsCreated }`.
    #[napi]
    pub fn insert_access_member<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: gbrain_store::access_members::AccessMemberInsert =
                required(spec, "insertAccessMember spec")?;
            s.insert_access_member(&spec)
        })
    }

    /// `setAccessMemberDisabled(id, disabled)`: resolves null.
    #[napi]
    pub fn set_access_member_disabled<'env>(
        &self,
        env: &'env Env,
        id: String,
        disabled: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_access_member_disabled(&id, disabled))
    }

    /// `setAccessMemberEmail(id, email | null)`: true when a member that is not removed changed.
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

    /// `setAccessMemberKind(id, kind)`: resolves null.
    #[napi]
    pub fn set_access_member_kind<'env>(
        &self,
        env: &'env Env,
        id: String,
        kind: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_access_member_kind(&id, &kind))
    }

    /// `setAccessMemberLabelledOnly(id, labelledOnly)`: resolves null.
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

    /// `tombstoneAccessMember(id)`: resolves null.
    #[napi]
    pub fn tombstone_access_member<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.tombstone_access_member(&id))
    }

    /// `addAccessGroupMembers(groupId, memberIds)`: true when the group was created.
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

    /// `removeAccessGroupMembers(groupId, memberIds)`: resolves null.
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

    /// `deleteAccessGroup(id)`: resolves null.
    #[napi]
    pub fn delete_access_group<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_access_group(&id))
    }

    /// `readAccessMembers({ id } | { email } | { includeRemoved })`: `AccessMemberRow[]`.
    #[napi]
    pub fn read_access_members<'env>(
        &self,
        env: &'env Env,
        lookup: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let lookup: gbrain_store::access_members::AccessMemberLookup =
                required(lookup, "readAccessMembers lookup")?;
            s.read_access_members(&lookup)
        })
    }

    /// `readAccessGroups(id)`: `{ id, members }[]`, every group or the one `id` names.
    #[napi]
    pub fn read_access_groups<'env>(
        &self,
        env: &'env Env,
        id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_groups(id.as_deref()))
    }

    /// `readAccessGroupIds(ids)`: the ids that name an existing group, in byte order.
    #[napi]
    pub fn read_access_group_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_group_ids(&ids))
    }

    /// `listActiveAccessMembers()`: the enabled member ids, by id.
    #[napi]
    pub fn list_active_access_members<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_active_access_members())
    }

    /// `readAccessMemberLink(system, externalId)`: `{ system, external_id, member_id, created_at }` or null.
    #[napi]
    pub fn read_access_member_link<'env>(
        &self,
        env: &'env Env,
        system: String,
        external_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_access_member_link(&system, &external_id)
        })
    }

    /// `readLinkedMember(system, externalId)`: `{ id, groups }` of the enabled member the link names, or null.
    #[napi]
    pub fn read_linked_member<'env>(
        &self,
        env: &'env Env,
        system: String,
        external_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_linked_member(&system, &external_id))
    }

    /// `insertAccessMemberLink(system, externalId, memberId)`: resolves null.
    #[napi]
    pub fn insert_access_member_link<'env>(
        &self,
        env: &'env Env,
        system: String,
        external_id: String,
        member_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_access_member_link(&system, &external_id, &member_id)
        })
    }

    /// `deleteAccessMemberLink(system, externalId)`: resolves null.
    #[napi]
    pub fn delete_access_member_link<'env>(
        &self,
        env: &'env Env,
        system: String,
        external_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_access_member_link(&system, &external_id)
        })
    }

    /// `listAccessMemberLinks(memberId | null)`: every link, or one member's, by member, system and id.
    #[napi]
    pub fn list_access_member_links<'env>(
        &self,
        env: &'env Env,
        member_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_access_member_links(member_id.as_deref())
        })
    }

    /// `readSharedSourceRows()`: every live source with its config, guest flag, bound members and
    /// the owner member, in byte order of the id.
    #[napi]
    pub fn read_shared_source_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_shared_source_rows())
    }
}
